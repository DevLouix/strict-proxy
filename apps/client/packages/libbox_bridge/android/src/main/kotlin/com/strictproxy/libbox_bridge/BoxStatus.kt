package com.strictproxy.libbox_bridge

import java.util.concurrent.CopyOnWriteArraySet

/**
 * The tunnel state, owned by the service and read by the Flutter plugin.
 *
 * The service and the plugin live in the same process, so this in-process
 * observer is the whole transport. The previous design ran the engine in a
 * second process and needed a `Messenger` binder plus a timeout to decide
 * whether the process had launched at all; that guess is what produced the
 * "Android blocked the VPN service" message, and it cannot be wrong here
 * because there is no second process to be unreachable.
 *
 * Updates happen on the main thread. Listeners are copied and invoked outside
 * any lock so one that throws cannot stop the others.
 */
internal object BoxStatus {
    const val DISCONNECTED = "disconnected"
    const val CONNECTING = "connecting"
    const val CONNECTED = "connected"
    const val DISCONNECTING = "disconnecting"
    const val ERROR = "error"

    @Volatile
    var state: String = DISCONNECTED
        private set

    /** Why the last attempt failed, when the platform layer knows. */
    @Volatile
    var message: String? = null
        private set

    /**
     * The last reason an attempt failed, kept after later state changes.
     *
     * [message] is per-update: publishing `connected` clears it. A failure that
     * then arrives without its own message left the app with nothing to show,
     * which is how every engine crash turned into "The VPN engine reported an
     * error." This field survives those overwrites.
     */
    @Volatile
    var lastError: String? = null
        private set

    /**
     * The last state published, used only to reject a stale `connected`.
     *
     * A start runs on the service's worker thread and publishes at the end, so
     * a stop that arrives while it is starting can destroy the service first
     * and be followed by `connected` from the start that had already been in
     * flight. The tun is gone at that point, but the app would sit on a
     * connected state that nothing can end — the "the VPN did not shut down"
     * report — so `connected` is only accepted from `connecting`/`connected`,
     * the two states a successful start can legitimately follow.
     */
    @Volatile
    private var lastPublished = DISCONNECTED

    private val listeners = CopyOnWriteArraySet<(String, String?) -> Unit>()

    /** Whether a tunnel is up or being brought up. */
    val isActive: Boolean
        get() = state == CONNECTING || state == CONNECTED || state == DISCONNECTING

    fun update(state: String, message: String? = null) {
        synchronized(this) {
            if (state == CONNECTED && lastPublished != CONNECTING && lastPublished != CONNECTED) return
            lastPublished = state
        }
        this.state = state
        this.message = message
        if (state == ERROR && !message.isNullOrBlank()) lastError = message
        for (listener in listeners) {
            runCatching { listener(state, message) }
        }
    }

    fun addListener(listener: (String, String?) -> Unit) {
        listeners.add(listener)
    }

    fun removeListener(listener: (String, String?) -> Unit) {
        listeners.remove(listener)
    }
}

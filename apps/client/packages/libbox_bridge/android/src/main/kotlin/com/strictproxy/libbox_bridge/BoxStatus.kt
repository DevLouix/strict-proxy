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

    private val listeners = CopyOnWriteArraySet<(String, String?) -> Unit>()

    /** Whether a tunnel is up or being brought up. */
    val isActive: Boolean
        get() = state == CONNECTING || state == CONNECTED || state == DISCONNECTING

    fun update(state: String, message: String? = null) {
        this.state = state
        this.message = message
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

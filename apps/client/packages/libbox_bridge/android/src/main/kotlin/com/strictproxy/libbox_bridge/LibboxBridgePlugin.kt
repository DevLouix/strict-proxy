package com.strictproxy.libbox_bridge

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.VpnService
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import androidx.annotation.NonNull
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry

/**
 * Registers the strict_proxy/libbox channel and owns Android VPN permission flow.
 *
 * The service runs in its own `:vpn` process, so it cannot call this channel
 * directly: a native abort inside the engine must kill only the service. State
 * arrives over a [Messenger] binder instead of package broadcasts, and the
 * binder itself is the liveness signal — `onServiceDisconnected` fires the
 * moment that process dies, where the previous heartbeat scheme needed tens of
 * seconds of silence before it could say the same thing.
 *
 * A reconnect also reattaches instead of guessing: on every bind the app asks
 * the service for its current state, so opening the app while a tunnel is
 * already up shows it as connected.
 */
class LibboxBridgePlugin : FlutterPlugin, MethodChannel.MethodCallHandler, ActivityAware,
    PluginRegistry.ActivityResultListener {
    companion object {
        private const val CHANNEL = "strict_proxy/libbox"
        private const val VPN_PERMISSION_REQUEST = 48117

        /**
         * Longest wait for a started service to hand back its binder.
         *
         * The service answers as soon as the process exists, before any engine
         * work, so silence for this long does not mean a slow engine: Android
         * never launched the process at all. That is what is left behind after
         * the engine process crashed and was closed, and without this check the
         * attempt sits in `connecting` until a timeout that says nothing about
         * the cause.
         */
        private const val START_ACK_TIMEOUT_MS = 8_000L

        private const val BLOCKED_MESSAGE =
            "Android blocked the VPN service after the engine process crashed. " +
                "Force stop StrictProxy in Settings → Apps, reopen it, then try again."

        private const val DIED_MESSAGE = "The VPN engine stopped unexpectedly. Try connecting again."
    }

    private var channel: MethodChannel? = null
    private var activity: Activity? = null
    private var appContext: Context? = null
    private var pendingConfig: String? = null
    private var pendingResult: MethodChannel.Result? = null

    /** The last state the service reported; `connecting`/`connected` are live. */
    private var lastState = "disconnected"

    /** Non-null while the `:vpn` process is alive and reachable. */
    private var serviceMessenger: Messenger? = null

    /** Whether `bindService` succeeded and has not been undone yet. */
    private var binding = false

    /**
     * What this app process has asked of `:vpn`, and what it heard back.
     *
     * Both of its rules came from a real failure: a start Android silently
     * refused looked exactly like a slow tunnel, and a disconnect cold-started
     * `:vpn` just to tell it to stop — a launch of the process the system had
     * already marked bad. "Heard" is now "the binder arrived", which is the same
     * fact with a much shorter delay.
     */
    private val latch = ServiceLatch()
    private val handler = Handler(Looper.getMainLooper())

    /** Receives every state the service publishes. */
    private val incoming = Messenger(object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(msg: Message) {
            if (msg.what != LibboxVpnService.MESSAGE_STATE) return
            val state = msg.data.getString(LibboxVpnService.EXTRA_STATE) ?: return
            val message = msg.data.getString(LibboxVpnService.EXTRA_MESSAGE)
            latch.heard()
            handler.removeCallbacks(startAckTimeout)
            lastState = state
            emit(state, message)
        }
    })

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            if (binder == null) {
                refused()
                return
            }
            serviceMessenger = Messenger(binder)
            latch.heard()
            handler.removeCallbacks(startAckTimeout)
            // Ask what the service is already doing before assuming anything:
            // this is what makes a running tunnel visible again after the app
            // process was recreated, and it closes the race with a start that
            // produced its first state before this bind completed.
            sendToService(LibboxVpnService.MESSAGE_SYNC)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            // The `:vpn` process died — a native abort, or the system killed it.
            serviceMessenger = null
            binding = false
            noteDeath()
        }

        override fun onBindingDied(name: ComponentName?) {
            serviceMessenger = null
            binding = false
            runCatching { appContext?.unbindService(this) }
            noteDeath()
        }

        override fun onNullBinding(name: ComponentName?) {
            // The service refused to hand back a binder; treat it as the same
            // refusal a start that never reached the process would produce.
            serviceMessenger = null
            binding = false
            runCatching { appContext?.unbindService(this) }
            refused()
        }
    }

    private val startAckTimeout = object : Runnable {
        override fun run() {
            if (!latch.ackExpired()) return
            lastState = "error"
            emit("error", BLOCKED_MESSAGE)
        }
    }

    override fun onAttachedToEngine(@NonNull binding: FlutterPlugin.FlutterPluginBinding) {
        appContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL).also { it.setMethodCallHandler(this) }
    }

    override fun onDetachedFromEngine(@NonNull binding: FlutterPlugin.FlutterPluginBinding) {
        handler.removeCallbacks(startAckTimeout)
        latch.startFailed()
        // Losing the Flutter engine must not stop the tunnel: the service was
        // started, not merely bound, so it keeps running and the next launch
        // reattaches to it.
        unbindService()
        channel?.setMethodCallHandler(null)
        channel = null
        appContext = null
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity
        binding.addActivityResultListener(this)
    }

    override fun onDetachedFromActivityForConfigChanges() { activity = null }
    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) { onAttachedToActivity(binding) }
    override fun onDetachedFromActivity() { activity = null }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != VPN_PERMISSION_REQUEST) return false
        val config = pendingConfig
        val result = pendingResult
        pendingConfig = null
        pendingResult = null
        if (resultCode != Activity.RESULT_OK || config == null) {
            result?.error("vpn_permission_denied", "Android VPN permission was denied", null)
            emit("error", "Android VPN permission was denied")
            return true
        }
        startService(config, result ?: return true)
        return true
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "initialize" -> {
                // Binding here is what lets a relaunch discover a tunnel that is
                // still up; the service reports its state in reply.
                bindService()
                result.success(null)
            }
            "isAvailable" -> result.success(LibboxVpnService.isLibboxAvailable())
            "start" -> {
                val config = call.argument<String>("config")
                if (config.isNullOrBlank()) {
                    result.error("invalid_config", "A non-empty sing-box configuration is required", null)
                    return
                }
                val currentActivity = activity
                if (currentActivity == null) {
                    result.error("activity_unavailable", "The Android activity is not attached", null)
                    return
                }
                val permissionIntent = VpnService.prepare(currentActivity)
                if (permissionIntent != null) {
                    pendingConfig = config
                    pendingResult = result
                    currentActivity.startActivityForResult(permissionIntent, VPN_PERMISSION_REQUEST)
                } else {
                    startService(config, result)
                }
            }
            "stop" -> {
                val context = appContext ?: activity?.applicationContext
                // Only tell a service that exists to stop. A start still in
                // flight is stopped as well, or it would come up with nothing
                // left able to stop it. A service that is neither bound nor
                // starting is left alone: sending it an intent would cold-start
                // the very process Android refused.
                val wasAwaiting = latch.awaitingService
                val sendStop = latch.stopRequested()
                handler.removeCallbacks(startAckTimeout)
                if (sendStop) {
                    val messenger = serviceMessenger
                    if (messenger != null) {
                        sendToService(LibboxVpnService.MESSAGE_STOP)
                        lastState = "disconnecting"
                    } else if (wasAwaiting && context != null) {
                        LibboxVpnService.stop(context)
                        lastState = "disconnecting"
                    } else {
                        lastState = "disconnected"
                    }
                } else {
                    lastState = "disconnected"
                }
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private fun startService(config: String, result: MethodChannel.Result) {
        val context = appContext ?: activity?.applicationContext
        if (context == null) {
            result.error("activity_unavailable", "The Android activity is not attached", null)
            return
        }
        // Ask for the binder first so no state produced during startup is missed.
        val bound = bindService()
        try {
            LibboxVpnService.start(context, config)
            lastState = "connecting"
            // An already-bound service will not call back again, so it has
            // already answered; only a fresh binding needs the deadline.
            if (bound && serviceMessenger != null) {
                latch.heard()
                handler.removeCallbacks(startAckTimeout)
            } else {
                latch.startRequested()
                handler.removeCallbacks(startAckTimeout)
                handler.postDelayed(startAckTimeout, START_ACK_TIMEOUT_MS)
            }
            result.success(null)
        } catch (error: Throwable) {
            latch.startFailed()
            handler.removeCallbacks(startAckTimeout)
            result.error("vpn_start_failed", error.message ?: "Unable to start VPN service", null)
            lastState = "error"
            emit("error", error.message ?: "Unable to start VPN service")
        }
    }

    /**
     * Binds to the service. Returns false when Android refused the request,
     * which is itself a start failure the caller has to report.
     */
    private fun bindService(): Boolean {
        if (binding) return true
        val context = appContext ?: activity?.applicationContext ?: return false
        binding = runCatching {
            context.bindService(
                Intent(context, LibboxVpnService::class.java),
                connection,
                Context.BIND_AUTO_CREATE,
            )
        }.getOrDefault(false)
        return binding
    }

    private fun unbindService() {
        serviceMessenger = null
        if (!binding) return
        binding = false
        runCatching { appContext?.unbindService(connection) }
    }

    private fun sendToService(what: Int) {
        val messenger = serviceMessenger ?: return
        val message = Message.obtain(null, what)
        message.replyTo = incoming
        try {
            messenger.send(message)
        } catch (error: Throwable) {
            // The process died between the last state and this call.
            serviceMessenger = null
            binding = false
            noteDeath()
        }
    }

    /** The service's process is gone. Say so if it was supposed to be running. */
    private fun noteDeath() {
        latch.startFailed()
        val wasLive = lastState == "connecting" || lastState == "connected" || lastState == "disconnecting"
        if (!wasLive) return
        lastState = "error"
        emit("error", DIED_MESSAGE)
    }

    /** Android never launched the process, or refused to bind to it. */
    private fun refused() {
        latch.startFailed()
        handler.removeCallbacks(startAckTimeout)
        lastState = "error"
        emit("error", BLOCKED_MESSAGE)
    }

    private fun emit(state: String, message: String?) {
        val payload: Any = if (message == null) state else mapOf("state" to state, "message" to message)
        channel?.invokeMethod("state", payload)
    }
}

package com.strictproxy.libbox_bridge

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.VpnService
import android.os.Handler
import android.os.Looper
import androidx.annotation.NonNull
import androidx.core.content.ContextCompat
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
 * arrives as package-scoped broadcasts instead, and silence is treated as death
 * — the service sends a heartbeat while it is up, and the engine is dead when
 * those stop.
 */
class LibboxBridgePlugin : FlutterPlugin, MethodChannel.MethodCallHandler, ActivityAware,
    PluginRegistry.ActivityResultListener {
    companion object {
        private const val CHANNEL = "strict_proxy/libbox"
        private const val VPN_PERMISSION_REQUEST = 48117

        /** Longest silence tolerated from the service before it is presumed dead. */
        private const val SILENCE_LIMIT_MS = 40_000L
        private const val LIVENESS_INTERVAL_MS = 15_000L

        /**
         * Longest wait for a freshly started service to announce itself.
         *
         * The service broadcasts `connecting` as the first thing
         * `onStartCommand` does, before any engine work, so silence for this
         * long does not mean a slow engine: the system never launched the
         * process at all.
         */
        private const val START_ACK_TIMEOUT_MS = 8_000L
    }

    private var channel: MethodChannel? = null
    private var activity: Activity? = null
    private var appContext: Context? = null
    private var receiver: BroadcastReceiver? = null
    private var pendingConfig: String? = null
    private var pendingResult: MethodChannel.Result? = null

    /** The last state the service reported; `connecting`/`connected` are live. */
    private var lastState = "disconnected"
    private var lastHeardAt = 0L

    /**
     * What this app process has asked of `:vpn`, and what it heard back.
     *
     * Both of its rules came from a real failure: a start Android silently
     * refused looked exactly like a slow tunnel, and a disconnect cold-started
     * `:vpn` just to tell it to stop — a launch of the process the system had
     * already marked bad. The rules live in [ServiceLatch] so they can be tested
     * on the JVM.
     */
    private val latch = ServiceLatch()
    private val liveness = Handler(Looper.getMainLooper())
    private val livenessCheck = object : Runnable {
        override fun run() {
            val alive = lastState == "connecting" || lastState == "connected"
            if (alive && System.currentTimeMillis() - lastHeardAt > SILENCE_LIMIT_MS) {
                // The service process died without a chance to report: a native
                // abort skips onDestroy and every broadcast. Say so instead of
                // leaving the app showing a tunnel that is no longer there.
                lastState = "error"
                emit("error", "The VPN engine stopped unexpectedly. Try connecting again.")
            }
            liveness.postDelayed(this, LIVENESS_INTERVAL_MS)
        }
    }

    /**
     * Fails a start that never reached the service.
     *
     * `startForegroundService` returns a component even when ActivityManager
     * refuses to launch the process, so a successful call proves nothing. That
     * refusal is logged as "Unable to launch app … : process is bad" and is what
     * is left behind after the engine process crashed and was closed: the
     * system will not start that process again, so every retry is refused the
     * same way. Without this check the attempt sits in `connecting` until the
     * Dart watchdog, which reports a timeout that says nothing about the cause.
     */
    private val startAckTimeout = object : Runnable {
        override fun run() {
            if (!latch.ackExpired()) return
            lastState = "error"
            emit(
                "error",
                "Android blocked the VPN service after the engine process crashed. " +
                    "Force stop StrictProxy in Settings → Apps, reopen it, then try again.",
            )
        }
    }

    override fun onAttachedToEngine(@NonNull binding: FlutterPlugin.FlutterPluginBinding) {
        val context = binding.applicationContext
        appContext = context
        channel = MethodChannel(binding.binaryMessenger, CHANNEL).also { it.setMethodCallHandler(this) }
        val stateReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val state = intent?.getStringExtra(LibboxVpnService.EXTRA_STATE) ?: return
                lastHeardAt = System.currentTimeMillis()
                latch.heard()
                liveness.removeCallbacks(startAckTimeout)
                if (state == "heartbeat") return
                lastState = state
                emit(state, intent.getStringExtra(LibboxVpnService.EXTRA_MESSAGE))
            }
        }
        receiver = stateReceiver
        ContextCompat.registerReceiver(
            context,
            stateReceiver,
            IntentFilter(LibboxVpnService.ACTION_STATE),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        liveness.postDelayed(livenessCheck, LIVENESS_INTERVAL_MS)
    }

    override fun onDetachedFromEngine(@NonNull binding: FlutterPlugin.FlutterPluginBinding) {
        liveness.removeCallbacks(livenessCheck)
        liveness.removeCallbacks(startAckTimeout)
        latch.startFailed()
        receiver?.let { runCatching { appContext?.unregisterReceiver(it) } }
        receiver = null
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
                lastState = "disconnected"
                emit("disconnected", null)
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
                // Only tell a service that exists to stop. A start still in flight
                // is stopped as well, or it would come up with nothing left able
                // to stop it.
                val sendStop = latch.stopRequested()
                liveness.removeCallbacks(startAckTimeout)
                if (context != null && sendStop) {
                    LibboxVpnService.stop(context)
                }
                lastState = "disconnecting"
                lastHeardAt = System.currentTimeMillis()
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
        try {
            LibboxVpnService.start(context, config)
            lastState = "connecting"
            lastHeardAt = System.currentTimeMillis()
            latch.startRequested()
            liveness.removeCallbacks(startAckTimeout)
            liveness.postDelayed(startAckTimeout, START_ACK_TIMEOUT_MS)
            result.success(null)
        } catch (error: Throwable) {
            latch.startFailed()
            liveness.removeCallbacks(startAckTimeout)
            result.error("vpn_start_failed", error.message ?: "Unable to start VPN service", null)
            lastState = "error"
            emit("error", error.message ?: "Unable to start VPN service")
        }
    }

    private fun emit(state: String, message: String?) {
        val payload: Any = if (message == null) state else mapOf("state" to state, "message" to message)
        channel?.invokeMethod("state", payload)
    }
}

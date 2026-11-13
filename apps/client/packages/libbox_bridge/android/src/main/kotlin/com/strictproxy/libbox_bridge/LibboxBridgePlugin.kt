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

    override fun onAttachedToEngine(@NonNull binding: FlutterPlugin.FlutterPluginBinding) {
        val context = binding.applicationContext
        appContext = context
        channel = MethodChannel(binding.binaryMessenger, CHANNEL).also { it.setMethodCallHandler(this) }
        val stateReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val state = intent?.getStringExtra(LibboxVpnService.EXTRA_STATE) ?: return
                lastHeardAt = System.currentTimeMillis()
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
                if (context != null) LibboxVpnService.stop(context)
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
            result.success(null)
        } catch (error: Throwable) {
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

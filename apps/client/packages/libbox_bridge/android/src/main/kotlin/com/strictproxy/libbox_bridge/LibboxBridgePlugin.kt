package com.strictproxy.libbox_bridge

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.VpnService
import androidx.annotation.NonNull
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry

/**
 * Registers the strict_proxy/libbox channel and owns Android's VPN permission
 * flow.
 *
 * The service, the engine and this plugin share the app process, so state is
 * read from [BoxStatus] and forwarded to Dart instead of arriving over a binder.
 * The previous design bound to a service in a second process, which meant every
 * connect had to guess whether that process had even started; see
 * [LibboxVpnService].
 *
 * The channel's methods are unchanged (`initialize`, `isAvailable`, `start`,
 * `stop`) and states keep the same names, so the Dart side needs no changes.
 */
class LibboxBridgePlugin : FlutterPlugin, MethodChannel.MethodCallHandler, ActivityAware,
    PluginRegistry.ActivityResultListener {
    companion object {
        private const val CHANNEL = "strict_proxy/libbox"
        private const val VPN_PERMISSION_REQUEST = 48117
    }

    private var channel: MethodChannel? = null
    private var activity: Activity? = null
    private var appContext: Context? = null
    private var pendingConfig: String? = null
    private var pendingResult: MethodChannel.Result? = null
    private var statusListener: ((String, String?) -> Unit)? = null

    override fun onAttachedToEngine(@NonNull binding: FlutterPlugin.FlutterPluginBinding) {
        appContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL).also { it.setMethodCallHandler(this) }
        val listener: (String, String?) -> Unit = { state, message -> emit(state, message) }
        statusListener = listener
        BoxStatus.addListener(listener)
    }

    override fun onDetachedFromEngine(@NonNull binding: FlutterPlugin.FlutterPluginBinding) {
        statusListener?.let { BoxStatus.removeListener(it) }
        statusListener = null
        channel?.setMethodCallHandler(null)
        channel = null
        appContext = null
        // Losing the Flutter engine must not stop the tunnel: the service was
        // started, not merely bound, and it keeps running.
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity
        binding.addActivityResultListener(this)
    }

    override fun onDetachedFromActivityForConfigChanges() {
        activity = null
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        onAttachedToActivity(binding)
    }

    override fun onDetachedFromActivity() {
        activity = null
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != VPN_PERMISSION_REQUEST) return false
        val config = pendingConfig
        val result = pendingResult
        pendingConfig = null
        pendingResult = null
        if (resultCode != Activity.RESULT_OK || config == null) {
            result?.error("vpn_permission_denied", "Android VPN permission was denied", null)
            emit(BoxStatus.ERROR, "Android VPN permission was denied")
            return true
        }
        startService(config, result ?: return true)
        return true
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "initialize" -> {
                // Report what the app already knows: if the plugin is created
                // again while a tunnel is up, the UI shows it as connected
                // without waiting for the next state change.
                emit(BoxStatus.state, BoxStatus.message)
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
            result.success(null)
        } catch (error: Throwable) {
            // ForegroundServiceStartNotAllowedException and friends: Android
            // refused the start request outright, before any engine work.
            result.error("vpn_start_failed", error.message ?: "Unable to start VPN service", null)
            emit(BoxStatus.ERROR, error.message ?: "Unable to start VPN service")
        }
    }

    private fun emit(state: String, message: String?) {
        val payload: Any = if (message == null) state else mapOf("state" to state, "message" to message)
        channel?.invokeMethod("state", payload)
    }
}

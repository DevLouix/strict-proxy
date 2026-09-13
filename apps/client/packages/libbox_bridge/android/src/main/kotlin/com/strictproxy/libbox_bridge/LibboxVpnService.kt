package com.strictproxy.libbox_bridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.core.app.NotificationCompat
import io.flutter.plugin.common.MethodChannel
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Method
import java.lang.reflect.Proxy

/**
 * Foreground Android VPN service. libbox is deliberately loaded reflectively:
 * the generated AAR is supplied by the pinned build script and its Java API
 * changes between sing-box releases. The bridge therefore remains source-
 * compatible while still invoking the real generated Libbox classes at runtime.
 */
class LibboxVpnService : VpnService() {
    companion object {
        private const val TAG = "StrictProxyLibbox"
        private const val ACTION_START = "com.strictproxy.libbox.START"
        private const val ACTION_STOP = "com.strictproxy.libbox.STOP"
        private const val EXTRA_CONFIG = "config"
        private const val CHANNEL_ID = "strict_proxy_vpn"
        private const val NOTIFICATION_ID = 48118
        private var methodChannel: MethodChannel? = null
        private var instance: LibboxVpnService? = null
        private var runningService: Any? = null
        private var tunFd: ParcelFileDescriptor? = null

        fun attachChannel(channel: MethodChannel) { methodChannel = channel }
        fun detachChannel() { methodChannel = null }

        fun isLibboxAvailable(): Boolean = try {
            Class.forName("io.nekohasekai.libbox.Libbox")
            true
        } catch (_: Throwable) { false }

        fun emitState(state: String, message: String? = null) {
            val payload = if (message == null) state else mapOf("state" to state, "message" to message)
            methodChannel?.invokeMethod("state", payload)
        }

        fun start(context: Context, config: String) {
            val intent = Intent(context, LibboxVpnService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_CONFIG, config)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun stop(currentActivity: android.app.Activity?) {
            val context = currentActivity?.applicationContext ?: instance ?: return
            context.startService(Intent(context, LibboxVpnService::class.java).setAction(ACTION_STOP))
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, notification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopBox()
            ACTION_START -> {
                val config = intent.getStringExtra(EXTRA_CONFIG)
                if (config.isNullOrBlank()) fail("missing libbox configuration") else startBox(config)
            }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? {
        return super.onBind(intent)
    }

    override fun onDestroy() {
        stopBox()
        instance = null
        super.onDestroy()
    }

    private fun startBox(config: String) {
        if (runningService != null) return
        emitState("connecting")
        try {
            val libbox = Class.forName("io.nekohasekai.libbox.Libbox")
            val newService = libbox.methods.firstOrNull {
                it.name.equals("newService", ignoreCase = true) && it.parameterTypes.size == 2
            } ?: error("libbox.aar does not expose Libbox.newService(config, platform)")
            val platformType = newService.parameterTypes[1]
            val platform = Proxy.newProxyInstance(
                platformType.classLoader,
                arrayOf(platformType),
                PlatformHandler(this),
            )
            val service = newService.invoke(null, config, platform) ?: error("Libbox.newService returned null")
            service.javaClass.methods.firstOrNull { it.name == "start" && it.parameterTypes.isEmpty() }
                ?.invoke(service) ?: error("libbox service has no start() method")
            runningService = service
            emitState("connected")
        } catch (error: Throwable) {
            stopBox()
            fail(error.cause?.message ?: error.message ?: "libbox failed to start")
        }
    }

    private fun stopBox() {
        emitState("disconnecting")
        try {
            runningService?.javaClass?.methods?.firstOrNull {
                (it.name == "close" || it.name == "stop") && it.parameterTypes.isEmpty()
            }?.invoke(runningService)
        } catch (error: Throwable) {
            Log.w(TAG, "libbox close failed", error)
        } finally {
            runningService = null
            tunFd?.close()
            tunFd = null
            emitState("disconnected")
            stopSelf()
        }
    }

    private fun fail(message: String) {
        Log.e(TAG, message)
        emitState("error", message)
        stopSelf()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "StrictProxy VPN", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    private fun notification(): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pending = launchIntent?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle("StrictProxy")
            .setContentText("VPN connection active")
            .setOngoing(true)
            .setContentIntent(pending)
            .build()
    }

    private class PlatformHandler(private val service: LibboxVpnService) : InvocationHandler {
        override fun invoke(proxy: Any, method: Method, args: Array<out Any?>?): Any? {
            if (method.name.equals("openTun", ignoreCase = true)) {
                return service.openTun(args?.firstOrNull())
            }
            if (method.name == "autoDetectInterfaceControl") return null
            return when (method.returnType) {
                java.lang.Boolean.TYPE -> false
                java.lang.Integer.TYPE, java.lang.Long.TYPE, java.lang.Short.TYPE -> 0
                java.lang.Float.TYPE, java.lang.Double.TYPE -> 0.0
                else -> null
            }
        }
    }

    private fun openTun(options: Any?): Int {
        val builder = Builder().setSession("StrictProxy")
        val mtu = readInt(options, "getMtu", "mtu")
        if (mtu > 0) builder.setMtu(mtu)
        addPrefixes(builder, readIterator(options, "getInet4Address"))
        addPrefixes(builder, readIterator(options, "getInet6Address"))
        val dns = readIterator(options, "getDnsServerAddress")
        while (hasNext(dns)) builder.addDnsServer(nextString(dns))
        if (readBoolean(options, "getAutoRoute", "autoRoute")) {
            val v4Routes = readIterator(options, "getInet4RouteAddress", "getInet4RouteRange")
            val v6Routes = readIterator(options, "getInet6RouteAddress", "getInet6RouteRange")
            if (hasNext(v4Routes)) while (hasNext(v4Routes)) addRoute(builder, next(v4Routes)) else builder.addRoute("0.0.0.0", 0)
            if (hasNext(v6Routes)) while (hasNext(v6Routes)) addRoute(builder, next(v6Routes)) else builder.addRoute("::", 0)
        }
        tunFd?.close()
        tunFd = builder.establish() ?: error("VpnService.Builder.establish returned null")
        return tunFd!!.fd
    }

    private fun addPrefixes(builder: Builder, iterator: Any?) {
        while (hasNext(iterator)) {
            val prefix = next(iterator) ?: continue
            val address = invokeString(prefix, "address") ?: continue
            val length = invokeInt(prefix, "prefix", "prefixLength")
            builder.addAddress(address, length)
        }
    }

    private fun addRoute(builder: Builder, prefix: Any?) {
        val address = invokeString(prefix, "address") ?: return
        builder.addRoute(address, invokeInt(prefix, "prefix", "prefixLength"))
    }

    private fun readIterator(target: Any?, vararg names: String): Any? {
        for (name in names) runCatching {
            val method = target?.javaClass?.methods?.firstOrNull { it.name == name && it.parameterTypes.isEmpty() }
            if (method != null) return method.invoke(target)
        }
        return null
    }

    private fun hasNext(iterator: Any?): Boolean = runCatching {
        iterator?.javaClass?.methods?.firstOrNull { it.name == "hasNext" }?.invoke(iterator) as? Boolean ?: false
    }.getOrDefault(false)

    private fun next(iterator: Any?): Any? = runCatching {
        iterator?.javaClass?.methods?.firstOrNull { it.name == "next" }?.invoke(iterator)
    }.getOrNull()

    private fun nextString(iterator: Any?): String = next(iterator)?.toString() ?: ""

    private fun invokeString(target: Any?, name: String): String? = runCatching {
        target?.javaClass?.methods?.firstOrNull { it.name == name && it.parameterTypes.isEmpty() }?.invoke(target)?.toString()
    }.getOrNull()

    private fun invokeInt(target: Any?, vararg names: String): Int {
        for (name in names) runCatching {
            val value = target?.javaClass?.methods?.firstOrNull { it.name == name && it.parameterTypes.isEmpty() }?.invoke(target)
            if (value is Number) return value.toInt()
        }
        return 0
    }

    private fun readInt(target: Any?, vararg names: String): Int = invokeInt(target, *names)
    private fun readBoolean(target: Any?, vararg names: String): Boolean = names.any { name -> runCatching {
        target?.javaClass?.methods?.firstOrNull { it.name == name && it.parameterTypes.isEmpty() }?.invoke(target) as? Boolean ?: false
    }.getOrDefault(false) }
}

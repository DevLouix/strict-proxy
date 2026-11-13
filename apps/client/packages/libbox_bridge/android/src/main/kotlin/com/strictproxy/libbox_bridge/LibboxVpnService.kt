package com.strictproxy.libbox_bridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import java.lang.reflect.Proxy
import java.net.InterfaceAddress
import java.net.NetworkInterface

/**
 * Foreground Android VPN service. libbox is deliberately loaded reflectively:
 * the generated AAR is supplied by the pinned build script and its Java API
 * changes between sing-box releases. The bridge therefore remains source-
 * compatible while still invoking the real generated Libbox classes at runtime.
 *
 * sing-box 1.13 replaced the old entry point
 * (`Libbox.newService(config, platform)`) with `Libbox.setup(SetupOptions)` +
 * `Libbox.newCommandServer(platform, handler)` +
 * `CommandServer.startOrReloadService(config, options)`. Both shapes are
 * resolved at runtime, so an engine bump that only moves the pin keeps working
 * and an older pin still falls back to the legacy call.
 */
class LibboxVpnService : VpnService() {
    companion object {
        private const val TAG = "StrictProxyLibbox"
        private const val ACTION_START = "com.strictproxy.libbox.START"
        private const val ACTION_STOP = "com.strictproxy.libbox.STOP"
        private const val EXTRA_CONFIG = "config"
        private const val CHANNEL_ID = "strict_proxy_vpn"
        private const val NOTIFICATION_ID = 48118
        private const val HEARTBEAT_MS = 10_000L

        /**
         * State changes, broadcast to the app process because this service runs
         * in `:vpn` and cannot reach the Flutter channel directly.
         */
        const val ACTION_STATE = "com.strictproxy.libbox.STATE"
        const val EXTRA_STATE = "state"
        const val EXTRA_MESSAGE = "message"

        /**
         * `Libbox.setup` may run once per process: the Go side keeps global
         * state and aborts the process if it is initialised again. Android
         * recreates the service on every connect, so this flag has to live on
         * the companion rather than on the instance.
         */
        private var enginePrepared = false
        private var runningService: Any? = null
        private var tunFd: ParcelFileDescriptor? = null

        fun isLibboxAvailable(): Boolean = try {
            Class.forName("io.nekohasekai.libbox.Libbox")
            true
        } catch (_: Throwable) { false }

        /**
         * What a proxy method returns when there is nothing useful to say.
         *
         * Primitives must not be null: a `Proxy` returning null for an int or
         * boolean throws a NullPointerException inside libbox's call, which is
         * reported as a native crash.
         */
        fun defaultValue(method: Method): Any? = when (method.returnType) {
            Void.TYPE -> null
            java.lang.Boolean.TYPE -> false
            java.lang.Integer.TYPE, java.lang.Long.TYPE, java.lang.Short.TYPE, java.lang.Byte.TYPE -> 0
            java.lang.Float.TYPE, java.lang.Double.TYPE -> 0.0
            java.lang.Character.TYPE -> '\u0000'
            else -> null
        }

        fun start(context: Context, config: String) {
            val intent = Intent(context, LibboxVpnService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_CONFIG, config)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, LibboxVpnService::class.java).setAction(ACTION_STOP))
        }
    }

    private val heartbeat = object : Runnable {
        override fun run() {
            emitState("heartbeat")
            handler.postDelayed(this, HEARTBEAT_MS)
        }
    }
    private val handler = Handler(Looper.getMainLooper())

    /**
     * Announces a state change to the app process. A missing channel here is
     * normal, not a failure: this class lives in `:vpn` while the Flutter
     * engine lives in the main one.
     */
    fun emitState(state: String, message: String? = null) {
        val intent = Intent(ACTION_STATE)
            .setPackage(packageName)
            .putExtra(EXTRA_STATE, state)
        if (message != null) intent.putExtra(EXTRA_MESSAGE, message)
        sendBroadcast(intent)
    }

    override fun onCreate() {
        super.onCreate()
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
        super.onDestroy()
    }

    private fun startBox(config: String) {
        if (runningService != null) return
        emitState("connecting")
        try {
            val libbox = Class.forName("io.nekohasekai.libbox.Libbox")
            runningService = startCommandServer(libbox, config) ?: startLegacyService(libbox, config)
            emitState("connected")
            // The app process treats silence as process death, so a live tunnel
            // has to keep saying so.
            handler.removeCallbacks(heartbeat)
            handler.postDelayed(heartbeat, HEARTBEAT_MS)
        } catch (error: Throwable) {
            stopBox()
            val cause = generateSequence(error) { it.cause }.last()
            fail(cause.message ?: "libbox failed to start")
        }
    }

    /**
     * The 1.13+ entry point. Returns null when this AAR predates it, so the
     * caller can fall back to [startLegacyService].
     */
    private fun startCommandServer(libbox: Class<*>, config: String): Any? {
        val factory = libbox.methods.firstOrNull {
            Modifier.isStatic(it.modifiers) &&
                it.name.equals("newCommandServer", ignoreCase = true) &&
                it.parameterTypes.size == 2
        } ?: return null

        prepareEngine(libbox)

        // gomobile keeps the Go parameter order (handler, platform); resolve the
        // platform side by the one interface that exposes openTun.
        val types = factory.parameterTypes
        val platformIndex = types.indexOfFirst { type -> type.methods.any { it.name.equals("openTun", ignoreCase = true) } }
        if (platformIndex < 0) return null
        val handlerIndex = 1 - platformIndex
        val arguments = arrayOfNulls<Any>(2)
        arguments[platformIndex] = platformProxy(types[platformIndex])
        arguments[handlerIndex] = Proxy.newProxyInstance(
            types[handlerIndex].classLoader,
            arrayOf(types[handlerIndex]),
            CommandHandler(),
        )

        val server = factory.invoke(null, *arguments) ?: error("libbox newCommandServer returned null")
        server.javaClass.methods.firstOrNull { it.name == "start" && it.parameterTypes.isEmpty() }?.invoke(server)
        val reload = server.javaClass.methods.firstOrNull {
            it.name.equals("startOrReloadService", ignoreCase = true) && it.parameterTypes.size in 1..2
        } ?: error("libbox command server has no startOrReloadService")
        if (reload.parameterTypes.size == 2) {
            val override = runCatching {
                Class.forName("io.nekohasekai.libbox.OverrideOptions").getDeclaredConstructor().newInstance()
            }.getOrNull()
            reload.invoke(server, config, override)
        } else {
            reload.invoke(server, config)
        }
        return server
    }

    /** The pre-1.13 entry point, kept so an older AAR still connects. */
    private fun startLegacyService(libbox: Class<*>, config: String): Any {
        val newService = libbox.methods.firstOrNull {
            it.name.equals("newService", ignoreCase = true) && it.parameterTypes.size == 2
        } ?: error("libbox.aar exposes neither newCommandServer nor newService(config, platform)")
        val platformType = newService.parameterTypes[1]
        val service = newService.invoke(null, config, platformProxy(platformType))
            ?: error("Libbox.newService returned null")
        service.javaClass.methods.firstOrNull { it.name == "start" && it.parameterTypes.isEmpty() }?.invoke(service)
        return service
    }

    private fun platformProxy(type: Class<*>): Any =
        Proxy.newProxyInstance(type.classLoader, arrayOf(type), PlatformHandler(this))

    /**
     * `SetupOptions` carries the writable directories libbox needs before any
     * service exists. Field names differ between releases, so setters are
     * matched case-insensitively and a missing one is ignored.
     */
    private fun prepareEngine(libbox: Class<*>) {
        if (enginePrepared) return
        val setup = libbox.methods.firstOrNull {
            Modifier.isStatic(it.modifiers) &&
                it.name.equals("setup", ignoreCase = true) &&
                it.parameterTypes.size == 1
        } ?: return
        val options = setup.parameterTypes[0].getDeclaredConstructor().newInstance()
        val files = filesDir.absolutePath
        setOption(options, "BasePath", files)
        setOption(options, "WorkingPath", File(files, "libbox").apply { mkdirs() }.absolutePath)
        setOption(options, "TempPath", File(cacheDir, "libbox").apply { mkdirs() }.absolutePath)
        setOption(options, "LogMaxLines", 300)
        setOption(options, "FixAndroidStack", true)
        setOption(options, "AppVersion", appVersion())
        setOption(options, "AppMarketingVersion", appVersion())
        setup.invoke(null, options)
        enginePrepared = true
    }

    private fun appVersion(): String = runCatching {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "0.1.0"
    }.getOrDefault("0.1.0")

    private fun setOption(target: Any, field: String, value: Any) {
        val methods = target.javaClass.methods.filter { it.parameterTypes.size == 1 && it.name.startsWith("set") }
        val method = methods.firstOrNull { it.name.equals("set$field", ignoreCase = true) }
            ?: methods.firstOrNull { it.name.contains(field, ignoreCase = true) }
            ?: return
        runCatching { method.invoke(target, value) }
    }

    private fun stopBox() {
        emitState("disconnecting")
        try {
            runningService?.let { service ->
                service.javaClass.methods.firstOrNull {
                    it.name.equals("closeService", ignoreCase = true) && it.parameterTypes.isEmpty()
                }?.invoke(service)
                service.javaClass.methods.firstOrNull {
                    (it.name == "close" || it.name == "stop") && it.parameterTypes.isEmpty()
                }?.invoke(service)
            }
        } catch (error: Throwable) {
            Log.w(TAG, "libbox close failed", error)
        } finally {
            runningService = null
            tunFd?.close()
            tunFd = null
            handler.removeCallbacks(heartbeat)
            emitState("disconnected")
            stopSelf()
        }
    }

    private fun fail(message: String) {
        Log.e(TAG, message)
        emitState("error", message)
        stopSelf()
    }

    /** Handler callbacks libbox requires; none of them need app state. */
    private inner class CommandHandler : InvocationHandler {
        override fun invoke(proxy: Any, method: Method, args: Array<out Any?>?): Any? {
            when {
                method.name.equals("serviceStop", ignoreCase = true) -> emitState("disconnected")
                method.name.equals("serviceReload", ignoreCase = true) -> Unit
                method.name.equals("writeDebugMessage", ignoreCase = true) ->
                    Log.d(TAG, args?.firstOrNull()?.toString() ?: "")
                method.name.equals("getSystemProxyStatus", ignoreCase = true) -> return systemProxyStatus()
            }
            return when (method.returnType) {
                Void.TYPE -> null
                java.lang.Boolean.TYPE -> false
                Integer.TYPE, java.lang.Long.TYPE, java.lang.Short.TYPE -> 0
                java.lang.Float.TYPE, java.lang.Double.TYPE -> 0.0
                else -> null
            }
        }
    }

    private fun systemProxyStatus(): Any? = runCatching {
        val status = Class.forName("io.nekohasekai.libbox.SystemProxyStatus").getDeclaredConstructor().newInstance()
        setOption(status, "Available", false)
        setOption(status, "Enabled", false)
        status
    }.getOrNull()

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

    /**
     * The platform callbacks libbox makes into the VPN service.
     *
     * Two of them are load-bearing on Android and were previously answered with
     * `null`:
     *
     *  - `autoDetectInterfaceControl` must protect the socket, or the engine's own
     *    outbound connection goes back through the tunnel it just created. The
     *    configuration enables `auto_detect_interface`, so the callback is not
     *    optional.
     *  - `getInterfaces` must return an iterator. libbox reads it while resolving
     *    the default interface immediately after the service starts; a null is
     *    dereferenced in native code and the process dies — which is what "connects,
     *    then the app closes instantly" looks like from the outside.
     */
    private class PlatformHandler(private val service: LibboxVpnService) : InvocationHandler {
        override fun invoke(proxy: Any, method: Method, args: Array<out Any?>?): Any? {
            when {
                method.name.equals("openTun", ignoreCase = true) ->
                    return service.openTun(args?.firstOrNull())
                method.name.equals("autoDetectInterfaceControl", ignoreCase = true) -> {
                    (args?.firstOrNull() as? Number)?.let { service.protect(it.toInt()) }
                    return null
                }
                method.name.equals("getInterfaces", ignoreCase = true) ->
                    return runCatching { service.networkInterfaces(method.returnType) }
                        .getOrElse { error ->
                            // A broken callback here aborts the Go runtime. An empty
                            // list makes libbox fail the connection cleanly instead.
                            Log.e(TAG, "interface enumeration failed", error)
                            service.emptyIterator(method.returnType)
                        }
            }
            return defaultValue(method)
        }
    }

    /**
     * The device's interfaces, shaped like the generated libbox iterator.
     *
     * `NetworkInterface` is a Go struct, so its Java binding is a final class,
     * not an interface. A dynamic proxy cannot stand in for it: Proxy only
     * implements interfaces, and asking it for a class throws inside the
     * callback, which aborts the Go runtime and kills the process. The real
     * generated class is constructed and filled through its setters instead.
     *
     * Enumerated per call because libbox re-reads the list as networks change.
     */
    private fun networkInterfaces(iteratorType: Class<*>): Any {
        val interfaces = runCatching {
            NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
        }.getOrDefault(emptyList())
        // An interface that cannot be represented is skipped: a malformed entry
        // (null iterator fields) would abort the Go side, while a short list is
        // just a less precise default-interface choice.
        val items = interfaces.mapNotNull { iface ->
            runCatching { libboxNetworkInterface(iface) }
                .onFailure { Log.w(TAG, "skipping interface ${iface.name}", it) }
                .getOrNull()
        }
        var index = -1
        return Proxy.newProxyInstance(iteratorType.classLoader, arrayOf(iteratorType), InvocationHandler { _, method, _ ->
            when {
                method.name.equals("hasNext", ignoreCase = true) -> index + 1 < items.size
                method.name.equals("next", ignoreCase = true) ->
                    if (index + 1 < items.size) items[++index] else null
                else -> defaultValue(method)
            }
        })
    }

    /** Fills one generated `NetworkInterface` from the Android interface. */
    private fun libboxNetworkInterface(iface: NetworkInterface): Any {
        val type = Class.forName("io.nekohasekai.libbox.NetworkInterface")
        val result = type.getDeclaredConstructor().newInstance()
        setRequired(result, "setName", iface.name)
        setRequired(result, "setIndex", iface.index)
        optionalSetter(result, "setMTU", runCatching { iface.mtu }.getOrDefault(0))
        optionalSetter(result, "setFlags", interfaceFlags(iface))
        optionalSetter(result, "setType", interfaceType(iface))
        optionalSetter(result, "setMetered", false)

        // Addresses, DNS and the gateway are object fields. Leaving one null
        // makes libbox dereference a null iterator in Go, which is a process
        // abort, so they are always filled — with an empty iterator when there
        // is nothing to report.
        val stringIteratorType = Class.forName("io.nekohasekai.libbox.StringIterator")
        val addresses = iface.interfaceAddresses.mapNotNull { prefixString(it) }
        setRequired(result, "setAddresses", stringIterator(stringIteratorType, addresses))
        result.javaClass.methods.firstOrNull {
            it.parameterTypes.size == 1 &&
                (it.name.equals("setDNSServer", ignoreCase = true) || it.name.equals("setDNSServers", ignoreCase = true))
        }?.let { setter ->
            setter.invoke(result, stringIterator(setter.parameterTypes[0], emptyList()))
        }
        // Newer engines carry a gateway list; older ones have no such field.
        result.javaClass.methods.firstOrNull {
            it.parameterTypes.size == 1 && it.name.equals("setGateway", ignoreCase = true)
        }?.let { setter ->
            setter.invoke(result, stringIterator(setter.parameterTypes[0], emptyList()))
        }
        return result
    }

    /** A generated libbox string iterator over [values]. */
    private fun stringIterator(iteratorType: Class<*>, values: List<String>): Any {
        var index = -1
        return Proxy.newProxyInstance(iteratorType.classLoader, arrayOf(iteratorType), InvocationHandler { _, method, _ ->
            when {
                method.name.equals("hasNext", ignoreCase = true) -> index + 1 < values.size
                method.name.equals("next", ignoreCase = true) -> values.getOrElse(++index) { "" }
                method.name.equals("len", ignoreCase = true) -> values.size
                else -> defaultValue(method)
            }
        })
    }

    /** An iterator that reports no entries. */
    private fun emptyIterator(iteratorType: Class<*>): Any =
        Proxy.newProxyInstance(iteratorType.classLoader, arrayOf(iteratorType), InvocationHandler { _, method, _ ->
            if (method.name.equals("hasNext", ignoreCase = true)) false else defaultValue(method)
        })

    private fun prefixString(address: InterfaceAddress): String? {
        val inet = address.address ?: return null
        // Scoped IPv6 addresses carry a `%wlan0` suffix that a sing-box prefix
        // parser rejects, so the interface part is dropped.
        val host = inet.hostAddress?.substringBefore('%') ?: return null
        val max = if (inet.address.size == 4) 32 else 128
        val prefix = address.networkPrefixLength.toInt().coerceIn(0, max)
        return "$host/$prefix"
    }

    /**
     * Android's `java.net.NetworkInterface` has no flags getter, so the Go
     * `net.Flags` bits libbox expects are assembled from the public booleans.
     */
    private fun interfaceFlags(iface: NetworkInterface): Int {
        var flags = 0
        if (runCatching { iface.isUp }.getOrDefault(false)) flags = flags or 0x1 or 0x40 // UP | RUNNING
        if (runCatching { iface.isLoopback }.getOrDefault(false)) flags = flags or 0x8
        if (runCatching { iface.isPointToPoint }.getOrDefault(false)) flags = flags or 0x10
        if (runCatching { iface.supportsMulticast() }.getOrDefault(false)) flags = flags or 0x1000
        return flags
    }

    private fun interfaceType(iface: NetworkInterface): Int {
        val name = iface.name.lowercase()
        return when {
            name.startsWith("wlan") -> libboxConstant("InterfaceTypeWIFI")
            name.startsWith("rmnet") || name.startsWith("ccmni") ||
                name.startsWith("pdp") || name.startsWith("wwan") -> libboxConstant("InterfaceTypeCellular")
            name.startsWith("eth") -> libboxConstant("InterfaceTypeEthernet")
            else -> libboxConstant("InterfaceTypeOther")
        }
    }

    private fun libboxConstant(name: String): Int = runCatching {
        Class.forName("io.nekohasekai.libbox.Libbox").getField(name).getInt(null)
    }.getOrDefault(0)

    private fun setRequired(target: Any, name: String, value: Any) {
        val method = target.javaClass.methods.firstOrNull {
            it.name.equals(name, ignoreCase = true) && it.parameterTypes.size == 1
        } ?: error("libbox ${target.javaClass.simpleName} has no $name")
        method.invoke(target, value)
    }

    private fun optionalSetter(target: Any, name: String, value: Any) {
        runCatching {
            target.javaClass.methods.firstOrNull {
                it.name.equals(name, ignoreCase = true) && it.parameterTypes.size == 1
            }?.invoke(target, value)
        }
    }

    private fun openTun(options: Any?): Int {
        val builder = Builder().setSession("StrictProxy")
        val mtu = readInt(options, "getMtu", "mtu")
        if (mtu > 0) builder.setMtu(mtu)
        addPrefixes(builder, readIterator(options, "getInet4Address"))
        addPrefixes(builder, readIterator(options, "getInet6Address"))
        // Newer engines hand DNS over in a StringBox, older ones an iterator;
        // accepting both keeps DNS intact across an engine bump.
        val dnsBox = runCatching {
            options?.javaClass?.methods?.firstOrNull {
                it.parameterTypes.isEmpty() &&
                    (it.name.equals("getDNSServerAddress", ignoreCase = true) ||
                        it.name.equals("getDnsServerAddress", ignoreCase = true))
            }?.invoke(options)
        }.getOrNull()
        val dnsValue = runCatching {
            dnsBox?.javaClass?.getMethod("getValue")?.invoke(dnsBox) as? String
        }.getOrNull()
        if (!dnsValue.isNullOrBlank()) builder.addDnsServer(dnsValue.substringBefore('%'))
        val dnsIterator = readIterator(options, "getDNSServerAddress", "getDnsServerAddress")
        while (hasNext(dnsIterator)) {
            val dns = nextString(dnsIterator).substringBefore('%')
            if (dns.isNotBlank()) builder.addDnsServer(dns)
        }
        if (readBoolean(options, "getAutoRoute", "autoRoute")) {
            val v4Routes = readIterator(options, "getInet4RouteAddress", "getInet4RouteRange")
            val v6Routes = readIterator(options, "getInet6RouteAddress", "getInet6RouteRange")
            if (hasNext(v4Routes)) while (hasNext(v4Routes)) addRoute(builder, next(v4Routes)) else builder.addRoute("0.0.0.0", 0)
            if (hasNext(v6Routes)) while (hasNext(v6Routes)) addRoute(builder, next(v6Routes)) else builder.addRoute("::", 0)
        }
        tunFd?.close()
        tunFd = null
        val descriptor = builder.establish() ?: error("VpnService.Builder.establish returned null")
        // The descriptor is handed to libbox, which owns it from here on. Keeping
        // the ParcelFileDescriptor as well and closing it in stopBox() would close
        // an fd native code is still reading — a double close, and a crash.
        return descriptor.detachFd()
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
            val method = target?.javaClass?.methods?.firstOrNull {
                it.name.equals(name, ignoreCase = true) && it.parameterTypes.isEmpty()
            }
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

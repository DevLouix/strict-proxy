package com.strictproxy.libbox_bridge

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.DnsResolver
import android.net.IpPrefix
import android.net.LinkAddress
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.VpnService
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.OsConstants
import android.util.Log
import androidx.annotation.RequiresApi
import io.nekohasekai.libbox.BridgeOptions
import io.nekohasekai.libbox.BridgeSession
import io.nekohasekai.libbox.ConnectionOwner
import io.nekohasekai.libbox.ExchangeContext
import io.nekohasekai.libbox.Func as LibboxFunc
import io.nekohasekai.libbox.InterfaceUpdateListener
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.LocalDNSTransport
import io.nekohasekai.libbox.NeighborUpdateListener
import io.nekohasekai.libbox.NetworkInterface
import io.nekohasekai.libbox.NetworkInterfaceIterator
import io.nekohasekai.libbox.Notification as LibboxNotification
import io.nekohasekai.libbox.PlatformInterface
import io.nekohasekai.libbox.PlatformUser
import io.nekohasekai.libbox.RoutePrefixIterator
import io.nekohasekai.libbox.ShellSession
import io.nekohasekai.libbox.StringIterator
import io.nekohasekai.libbox.TunOptions
import io.nekohasekai.libbox.WIFIState
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.InterfaceAddress
import java.net.NetworkInterface as AndroidNetworkInterface
import java.net.UnknownHostException
import java.util.concurrent.CancellationException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicReference

/**
 * Foreground Android VPN service, bound to the engine's generated Java API.
 *
 * The libbox classes are a compile dependency (`libs/libbox-classes.jar`, built
 * from the pinned commit by `tool/build-libbox.sh`), so an engine upgrade that
 * renames a callback or changes a signature fails the build here instead of
 * failing at runtime inside the tunnel. That is why this file implements the
 * engine's interfaces directly rather than answering them through reflection.
 *
 * ## One process
 *
 * This service, the engine and the Flutter UI share the app process. The
 * previous design ran the service in `:vpn` and talked to it over a `Messenger`
 * binder, which needed a timeout to decide whether that process had launched at
 * all — and that guess is what told users "Android blocked the VPN service"
 * after an engine crash. With one process there is nothing to be unreachable:
 * [BoxRunner] publishes to [BoxStatus] and the plugin forwards it to Dart. If
 * the engine aborts natively the app dies with it and Android relaunches it
 * normally on the next connect, instead of the app kept talking to a process
 * the system had given up on.
 *
 * Android's own client for this engine (`sing-box-for-android`) is laid out the
 * same way, for the same reason.
 */
class LibboxVpnService : VpnService(), PlatformInterface {
    companion object {
        private const val TAG = "StrictProxyLibbox"
        private const val DNS_QUERY_TIMEOUT_SECONDS = 10L
        private const val INTERFACE_RETRY_ATTEMPTS = 5
        private const val INTERFACE_RETRY_DELAY_MS = 100L

        /**
         * Whether the engine is packaged with this APK.
         *
         * Loads the native library, so a build that shipped the Java classes
         * without `libbox.so` reports "not available" instead of crashing when
         * the first tunnel starts.
         */
        fun isLibboxAvailable(): Boolean = runCatching { Libbox.version() }.isSuccess

        /**
         * True while a service instance exists in this process.
         *
         * The tun lives and dies with the service, so this — not the engine's
         * last state — is what decides whether a stop has completed. The state
         * can lag behind (or be left saying connected by a start that finished
         * after the service was destroyed), and waiting on it reported "the
         * VPN did not shut down" for a tunnel that was already gone.
         */
        @Volatile
        var isRunning: Boolean = false
            private set

        /**
         * True while the engine is still closing its service/command server
         * after a stop request. Waiters check both [isRunning] and this flag so
         * Disconnect only succeeds once both the TUN fd and Go engine have shut
         * down cleanly.
         */
        @Volatile
        var isTearingDown: Boolean = false
            internal set

        /**
         * Set when the app asks for the tunnel to stop.
         *
         * A start intent can already be queued with Android when the stop
         * arrives; without this, the queued start would bring the tunnel back
         * up after the user asked for it to be down.
         */
        @Volatile
        private var stopRequested = false

        /**
         * The live service, so a stop can close the TUN descriptor directly
         * from inside the service.
         *
         * While the TUN `ParcelFileDescriptor` stays open, Android's system Vpn
         * service holds a binding to this `VpnService`, so `stopService()` and
         * `stopSelf()` will not invoke `onDestroy()` until the TUN descriptor
         * is closed.
         */
        @Volatile
        private var instance: LibboxVpnService? = null

        fun start(context: Context, config: String) {
            // An explicit start is newer than any stop still being delivered.
            stopRequested = false
            val intent = Intent(context, LibboxVpnService::class.java)
                .putExtra(BoxRunner.EXTRA_CONFIG, config)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }

        /**
         * Stops the tunnel and the service.
         *
         * Drives teardown through the live service instance first so the TUN
         * descriptor is closed immediately (allowing Android to unbind the
         * `VpnService`), the engine is shut down on a dedicated thread, and
         * `stopSelf()` destroys the service cleanly.
         */
        fun stop(context: Context) {
            stopRequested = true
            val active = instance
            if (active != null) {
                EngineLog.append("closing the tunnel from the service")
                active.runner.stop()
                return
            }
            val stopped = runCatching {
                context.stopService(Intent(context, LibboxVpnService::class.java))
            }.onFailure {
                EngineLog.append("stopService failed: ${it.javaClass.simpleName}: ${it.message}")
            }.getOrDefault(false)
            EngineLog.append("stopService returned $stopped")
        }

        /** Fallback used when stop confirmation times out. */
        internal fun forceStopService(context: Context) {
            stopRequested = true
            instance?.let { service ->
                service.closeTun()
                service.runner.stop()
            }
            runCatching {
                context.stopService(Intent(context, LibboxVpnService::class.java))
            }.onFailure {
                EngineLog.append("force stopService failed: ${it.javaClass.simpleName}: ${it.message}")
            }
        }
    }

    private lateinit var runner: BoxRunner

    private val tunLock = Any()
    private var tunDescriptor: ParcelFileDescriptor? = null

    /**
     * The engine's default-interface listeners, and the system callbacks that
     * feed them.
     *
     * Concurrent maps are required because libbox registers/unregisters on Go
     * threads while Android delivers callbacks on [defaultNetworkThread] and
     * teardown runs on the teardown/main threads.
     */
    private val defaultInterfaceCallbacks =
        ConcurrentHashMap<InterfaceUpdateListener, ConnectivityManager.NetworkCallback>()

    /** The physical network last reported to each listener. */
    private val reportedDefaultNetworks = ConcurrentHashMap<InterfaceUpdateListener, Network>()

    @Volatile
    private var currentPhysicalNetwork: Network? = null

    private val networkThreadLock = Any()
    private var defaultNetworkThread: HandlerThread? = null
    private var defaultNetworkHandler: Handler? = null
    private val dnsExecutor: ExecutorService = Executors.newCachedThreadPool()

    private fun ensureDefaultNetworkHandler(): Handler = synchronized(networkThreadLock) {
        defaultNetworkHandler?.let { return it }
        val thread = HandlerThread("StrictProxyNetworkCallback").apply { start() }
        defaultNetworkThread = thread
        return Handler(thread.looper).also { defaultNetworkHandler = it }
    }

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        instance = this
        // Before the engine exists: a crash during setup still leaves a file
        // the next launch (and Diagnostics) can read. Attaching first also
        // keeps the previous launch's lines *above* this one in the log.
        EngineLog.attach(this)
        EngineLog.append("VPN service created")
        runner = BoxRunner(this, this)
        runner.create()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // The notification's Stop action is an intent rather than a broadcast, so
        // it cannot be lost for want of a registered receiver.
        if (intent?.action == BoxRunner.ACTION_STOP) {
            runner.stop()
            return START_NOT_STICKY
        }
        // The system can restart a killed service with no intent. There is no
        // configuration to rebuild from, so there is nothing to do.
        val config = intent?.getStringExtra(BoxRunner.EXTRA_CONFIG)
        if (config == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        // This start was queued before the user asked to stop.
        if (stopRequested) {
            EngineLog.append("dropping a start that was queued before the stop request")
            stopSelf()
            return START_NOT_STICKY
        }
        runner.begin(config)
        // The tunnel's lifetime is owned by the app's explicit start/stop, not
        // by whether this service happens to be running.
        return START_NOT_STICKY
    }

    override fun onRevoke() {
        runner.revoke()
        super.onRevoke()
    }

    override fun onDestroy() {
        // Cleared first: a stop that arrives while this runs must not queue more
        // work onto a service the system is already destroying.
        instance = null
        closeTun()
        closeAllDefaultInterfaceMonitors()
        currentPhysicalNetwork = null
        synchronized(networkThreadLock) {
            defaultNetworkThread?.quitSafely()
            defaultNetworkThread = null
            defaultNetworkHandler = null
        }
        dnsExecutor.shutdownNow()
        runner.destroy()
        isRunning = false
        super.onDestroy()
    }

    /**
     * Closes the active TUN `ParcelFileDescriptor`, removing `tun0` and
     * releasing Android's system VPN binding immediately. Safe to call
     * multiple times from any thread.
     */
    internal fun closeTun() {
        val descriptor = synchronized(tunLock) {
            val current = tunDescriptor
            tunDescriptor = null
            current
        } ?: return
        runCatching { descriptor.close() }
            .onFailure { Log.w(TAG, "closing tun descriptor failed", it) }
    }

    /** Unregisters every ConnectivityManager callback owned by this service. */
    internal fun closeAllDefaultInterfaceMonitors() {
        val listeners = defaultInterfaceCallbacks.keys.toList()
        for (listener in listeners) {
            closeDefaultInterfaceMonitor(listener)
        }
        reportedDefaultNetworks.clear()
    }

    // ---------------------------------------------------------------------
    // PlatformInterface: what libbox calls to reach the device
    // ---------------------------------------------------------------------

    /**
     * Protects a socket the engine opened so its own traffic does not re-enter
     * the tunnel it just created.
     *
     * Logged rather than thrown: the engine treats an exception from a platform
     * callback as a failed connection, and a socket that cannot be protected is
     * usually a transient state change, not a reason to tear the tunnel down.
     */
    override fun autoDetectInterfaceControl(fd: Int) {
        if (!protect(fd)) Log.w(TAG, "VpnService.protect($fd) failed")
    }

    override fun openTun(options: TunOptions): Int {
        // Consent lives in the app process, but the check is cheap and a
        // service started without it has no permission to establish anything.
        if (prepare(this) != null) error("android: missing vpn permission")

        val builder = Builder().setSession("StrictProxy")
        // Always pin the MTU: the engine's default (9000) exceeds the phone's
        // path MTU, which silently drops oversized segments and stalls every
        // TCP connection while the tunnel still reports connected.
        builder.setMtu(TunPlan.mtu(options.getMTU()))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) builder.setMetered(false)

        val inet4 = prefixes { options.getInet4Address() }
        val inet6 = prefixes { options.getInet6Address() }
        for (prefix in inet4) builder.addAddress(prefix.address, prefix.prefix)
        for (prefix in inet6) builder.addAddress(prefix.address, prefix.prefix)

        if (options.getAutoRoute()) {
            // The generated DNS getter throws when the engine has DNS disabled,
            // which is why its iterator is collected defensively. A tunnel with
            // no DNS server on its interface resolves nothing on the device, so
            // TunPlan substitutes a hijacked-in-tunnel fallback.
            val dnsEnabled = runCatching { options.getDNSMode()?.value != Libbox.DNSModeDisabled }.getOrDefault(true)
            if (dnsEnabled) {
                for (server in TunPlan.dnsServers(strings { options.getDNSServerAddress() })) {
                    builder.addDnsServer(server)
                }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                for (route in TunPlan.routes(prefixes { options.getInet4RouteAddress() }, "0.0.0.0", inet4.isNotEmpty())) {
                    builder.addRoute(route.address, route.prefix)
                }
                for (route in TunPlan.routes(prefixes { options.getInet6RouteAddress() }, "::", inet6.isNotEmpty())) {
                    builder.addRoute(route.address, route.prefix)
                }
                for (excluded in prefixes { options.getInet4RouteExcludeAddress() }) {
                    runCatching { builder.excludeRoute(IpPrefix(InetAddress.getByName(excluded.address), excluded.prefix)) }
                }
                for (excluded in prefixes { options.getInet6RouteExcludeAddress() }) {
                    runCatching { builder.excludeRoute(IpPrefix(InetAddress.getByName(excluded.address), excluded.prefix)) }
                }
            } else {
                for (route in TunPlan.routesForPreApi33(
                    prefixes { options.getInet4RouteRange() },
                    prefixes { options.getInet4RouteAddress() },
                    "0.0.0.0",
                    inet4.isNotEmpty(),
                )) {
                    builder.addRoute(route.address, route.prefix)
                }
                for (route in TunPlan.routesForPreApi33(
                    prefixes { options.getInet6RouteRange() },
                    prefixes { options.getInet6RouteAddress() },
                    "::",
                    inet6.isNotEmpty(),
                )) {
                    builder.addRoute(route.address, route.prefix)
                }
            }
            for (pkg in strings { options.getIncludePackage() }) {
                runCatching { builder.addAllowedApplication(pkg) }
                    .onFailure { Log.w(TAG, "addAllowedApplication($pkg) failed", it) }
            }
            for (pkg in strings { options.getExcludePackage() }) {
                runCatching { builder.addDisallowedApplication(pkg) }
                    .onFailure { Log.w(TAG, "addDisallowedApplication($pkg) failed", it) }
            }
        }

        val descriptor = builder.establish() ?: error("VpnService.Builder.establish returned null")
        val previous = synchronized(tunLock) {
            val old = tunDescriptor
            tunDescriptor = descriptor
            old
        }
        if (previous != null && previous !== descriptor) {
            runCatching { previous.close() }
                .onFailure { Log.w(TAG, "closing previous tun descriptor failed", it) }
        }
        // Return the fd WITHOUT calling detachFd(): libbox duplicates it via
        // dup() and only ever closes its duplicate. Keeping the descriptor here
        // lets closeTun() close the original fd on stop/destroy so Android
        // tears down tun0 and unbinds the VpnService immediately.
        return descriptor.fd
    }

    /**
     * Addresses or routes the engine reported for one family.
     *
     * An exception or a short list is survivable (the default-route fallback
     * covers it); a null iterator reaching Go is not.
     */
    private fun prefixes(iterator: () -> RoutePrefixIterator): List<TunPlan.Prefix> = runCatching {
        val source = iterator()
        val result = ArrayList<TunPlan.Prefix>()
        while (source.hasNext()) {
            val prefix = source.next()
            result.add(TunPlan.Prefix(prefix.address(), prefix.prefix()))
        }
        result
    }.getOrElse {
        Log.w(TAG, "libbox reported no addresses or routes for this family", it)
        emptyList()
    }

    private fun strings(iterator: () -> StringIterator): List<String> = runCatching {
        val source = iterator()
        val result = ArrayList<String>()
        while (source.hasNext()) result.add(source.next())
        result
    }.getOrElse {
        // DNS disabled: the generated getter refuses to hand back an iterator.
        emptyList()
    }

    /**
     * The device's active interfaces, shaped like the generated libbox iterator.
     *
     * Prefers Android's `ConnectivityManager.allNetworks` (matching
     * `sing-box-for-android`) so unmanaged interfaces like `dummy0`/`lo` are
     * excluded and `LinkProperties` supplies accurate addresses, MTU, DNS, and
     * gateways even on Android 11+ SELinux-restricted devices. Falls back to
     * `java.net.NetworkInterface` if `allNetworks` yields no usable entries.
     */
    override fun getInterfaces(): NetworkInterfaceIterator {
        val networkInfoByName = activeNetworkMetadataByInterface()
        val items = ArrayList<NetworkInterface>()

        for ((name, meta) in networkInfoByName) {
            val javaIface = runCatching { AndroidNetworkInterface.getByName(name) }.getOrNull() ?: continue
            runCatching { libboxInterface(javaIface, meta) }
                .onFailure { Log.w(TAG, "skipping network interface $name", it) }
                .getOrNull()
                ?.let { items.add(it) }
        }

        if (items.isEmpty()) {
            val fallbackInterfaces = runCatching {
                AndroidNetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
            }.getOrDefault(emptyList())
            for (iface in fallbackInterfaces) {
                val up = runCatching { iface.isUp }.getOrDefault(false)
                val loopback = runCatching { iface.isLoopback }.getOrDefault(false)
                if (!up || loopback) continue
                runCatching { libboxInterface(iface, null) }
                    .onFailure { Log.w(TAG, "skipping fallback interface ${iface.name}", it) }
                    .getOrNull()
                    ?.let { items.add(it) }
            }
        }

        return NetworkInterfaces(items)
    }

    private data class NetworkMetadata(
        val linkProperties: LinkProperties,
        val capabilities: NetworkCapabilities,
    )

    @Suppress("DEPRECATION")
    private fun activeNetworkMetadataByInterface(): Map<String, NetworkMetadata> = runCatching {
        val manager = connectivityManager
        val result = LinkedHashMap<String, NetworkMetadata>()
        for (network in manager.allNetworks) {
            val link = manager.getLinkProperties(network) ?: continue
            val name = link.interfaceName ?: continue
            val capabilities = manager.getNetworkCapabilities(network) ?: continue
            if (!result.containsKey(name) || !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                result[name] = NetworkMetadata(link, capabilities)
            }
        }
        result
    }.getOrDefault(emptyMap())

    private fun libboxInterface(iface: AndroidNetworkInterface, meta: NetworkMetadata?): NetworkInterface {
        val result = NetworkInterface()
        result.setName(iface.name)
        result.setIndex(iface.index)
        val capabilities = meta?.capabilities
        val link = meta?.linkProperties
        val linkMtu = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) link?.mtu ?: 0 else 0
        val mtu = if (linkMtu > 0) linkMtu else runCatching { iface.mtu }.getOrDefault(0)
        if (mtu > 0) optional { result.setMTU(mtu) }
        var flags = interfaceFlags(iface)
        if (capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true) {
            flags = flags or OsConstants.IFF_UP or OsConstants.IFF_RUNNING
        }
        result.setFlags(flags)
        result.setType(capabilities?.let { interfaceType(it, iface) } ?: interfaceType(iface))
        val metered = capabilities != null &&
            !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        result.setMetered(metered)
        val linkAddresses = link?.linkAddresses?.mapNotNull { linkPrefixString(it) }.orEmpty()
        val addresses = if (linkAddresses.isNotEmpty()) {
            linkAddresses
        } else {
            iface.interfaceAddresses.mapNotNull { prefixString(it) }
        }
        result.setAddresses(Strings(addresses))
        val dnsServers = link?.dnsServers?.mapNotNull { it.hostAddress }.orEmpty()
        val gateways = link?.routes
            ?.filter { it.destination.prefixLength == 0 }
            ?.mapNotNull { it.gateway }
            ?.filterNot { it.isAnyLocalAddress }
            ?.mapNotNull { it.hostAddress }
            .orEmpty()
        result.setDNSServer(Strings(dnsServers))
        result.setGateway(Strings(gateways))
        return result
    }

    private fun interfaceType(capabilities: NetworkCapabilities, iface: AndroidNetworkInterface): Int = when {
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> Libbox.InterfaceTypeWIFI
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> Libbox.InterfaceTypeCellular
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> Libbox.InterfaceTypeEthernet
        else -> interfaceType(iface)
    }

    private inline fun optional(block: () -> Unit) {
        runCatching(block)
    }

    private fun linkPrefixString(address: LinkAddress): String? {
        val inet = address.address ?: return null
        val host = inet.hostAddress?.substringBefore('%') ?: return null
        val max = if (inet.address.size == 4) 32 else 128
        val prefix = address.prefixLength.coerceIn(0, max)
        return "$host/$prefix"
    }

    private fun prefixString(address: InterfaceAddress): String? {
        val inet = address.address ?: return null
        val host = inet.hostAddress?.substringBefore('%') ?: return null
        val max = if (inet.address.size == 4) 32 else 128
        val prefix = address.networkPrefixLength.toInt().coerceIn(0, max)
        return "$host/$prefix"
    }

    /**
     * Android's `java.net.NetworkInterface` has no flags getter, so the POSIX
     * `IFF_*` bits libbox converts in `linkFlags` are assembled from the public
     * booleans.
     */
    private fun interfaceFlags(iface: AndroidNetworkInterface): Int {
        var flags = 0
        if (runCatching { iface.isUp }.getOrDefault(false)) {
            flags = flags or OsConstants.IFF_UP or OsConstants.IFF_RUNNING
        }
        if (runCatching { iface.isLoopback }.getOrDefault(false)) flags = flags or OsConstants.IFF_LOOPBACK
        if (runCatching { iface.isPointToPoint }.getOrDefault(false)) flags = flags or OsConstants.IFF_POINTOPOINT
        if (runCatching { iface.supportsMulticast() }.getOrDefault(false)) flags = flags or OsConstants.IFF_MULTICAST
        return flags
    }

    private fun interfaceType(iface: AndroidNetworkInterface): Int {
        val name = iface.name.lowercase()
        return when {
            name.startsWith("wlan") -> Libbox.InterfaceTypeWIFI
            name.startsWith("rmnet") || name.startsWith("ccmni") ||
                name.startsWith("pdp") || name.startsWith("wwan") -> Libbox.InterfaceTypeCellular
            name.startsWith("eth") -> Libbox.InterfaceTypeEthernet
            else -> Libbox.InterfaceTypeOther
        }
    }

    override fun includeAllNetworks() = false

    override fun underNetworkExtension() = false

    /** The engine must ask before opening a socket, or `protect` never runs. */
    override fun usePlatformAutoDetectInterfaceControl() = true

    override fun clearDNSCache() = Unit

    override fun registerMyInterface(name: String) = Unit

    override fun tailscaleHostname(): String = ""

    override fun cancelNotification(identifier: String, typeID: Int) = Unit

    /** StrictProxy shows its own foreground notification; the engine's is unused. */
    override fun sendNotification(notification: LibboxNotification) = Unit

    @Suppress("DEPRECATION")
    private fun findPhysicalNetwork(manager: ConnectivityManager): Network? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val active = manager.activeNetwork
            val caps = active?.let { manager.getNetworkCapabilities(it) }
            if (active != null &&
                caps != null &&
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
            ) {
                return active
            }
        }
        var fallback: Network? = null
        for (network in manager.allNetworks) {
            val caps = manager.getNetworkCapabilities(network) ?: continue
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue
            if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            ) {
                return network
            }
            if (fallback == null) fallback = network
        }
        return fallback
    }

    override fun startDefaultInterfaceMonitor(listener: InterfaceUpdateListener) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        val manager = connectivityManager
        // Seed the active physical network synchronously when available so
        // sing-box has an upstream default interface before the first callback,
        // even during a reload when activeNetwork points at our own VPN.
        findPhysicalNetwork(manager)?.let { physical ->
            reportDefaultInterface(manager, physical, listener, allowRetry = false)
        }
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) =
                reportDefaultInterface(manager, network, listener, allowRetry = true)

            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) =
                reportDefaultInterface(manager, network, listener, allowRetry = false)

            override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) =
                reportDefaultInterface(manager, network, listener, allowRetry = false)

            override fun onLost(network: Network) {
                if (reportedDefaultNetworks[listener] != network) return
                reportedDefaultNetworks.remove(listener)
                if (currentPhysicalNetwork == network) {
                    currentPhysicalNetwork = null
                }
                val replacement = findPhysicalNetwork(manager)
                if (replacement != null && replacement != network) {
                    reportDefaultInterface(manager, replacement, listener, allowRetry = false)
                    return
                }
                // libbox treats interfaceIndex == -1 as "no default interface".
                listener.updateDefaultInterface("", -1, false, false)
            }
        }
        defaultInterfaceCallbacks[listener] = callback
        // Request a non-VPN internet network on Android 9+: registerDefaultNetworkCallback
        // reports our own VPN tun as the default network once establish() succeeds.
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        runCatching {
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
                    manager.registerBestMatchingNetworkCallback(request, callback, ensureDefaultNetworkHandler())
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ->
                    manager.requestNetwork(request, callback, ensureDefaultNetworkHandler())
                else ->
                    manager.registerDefaultNetworkCallback(callback)
            }
        }.onFailure {
            defaultInterfaceCallbacks.remove(listener)
            Log.e(TAG, "could not monitor the default network", it)
        }
    }

    /**
     * Tells the engine which physical interface and index carries upstream traffic.
     *
     * VPN networks are always skipped (libbox's 4th parameter is `isConstrained`,
     * not `isVpn`). When invoked from an `onAvailable` callback on the background
     * handler thread, briefly retries if `LinkProperties` or the kernel interface
     * index has not settled yet.
     */
    private fun reportDefaultInterface(
        manager: ConnectivityManager,
        network: Network,
        listener: InterfaceUpdateListener,
        allowRetry: Boolean,
    ) {
        runCatching {
            val attempts = if (allowRetry) INTERFACE_RETRY_ATTEMPTS else 1
            for (attempt in 0 until attempts) {
                if (isTearingDown || !isRunning) return
                val link = manager.getLinkProperties(network)
                val name = link?.interfaceName
                val capabilities = manager.getNetworkCapabilities(network)
                val isVpn = capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
                if (isVpn) return
                val update = TunPlan.defaultInterfaceUpdate(name, isVpn = false)
                val index = update?.let { AndroidNetworkInterface.getByName(it.name)?.index }
                if (update != null && index != null) {
                    val metered = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == false
                    currentPhysicalNetwork = network
                    listener.updateDefaultInterface(update.name, index, metered, update.isConstrained)
                    reportedDefaultNetworks[listener] = network
                    return
                }
                if (attempt + 1 < attempts) {
                    Thread.sleep(INTERFACE_RETRY_DELAY_MS)
                }
            }
        }.onFailure {
            if (it !is InterruptedException) {
                Log.w(TAG, "could not report the default interface", it)
            }
        }
    }

    override fun closeDefaultInterfaceMonitor(listener: InterfaceUpdateListener) {
        reportedDefaultNetworks.remove(listener)
        val callback = defaultInterfaceCallbacks.remove(listener) ?: return
        runCatching { connectivityManager.unregisterNetworkCallback(callback) }
            .onFailure { Log.w(TAG, "could not stop the default network monitor", it) }
    }

    override fun startNeighborMonitor(listener: NeighborUpdateListener) = Unit

    override fun closeNeighborMonitor(listener: NeighborUpdateListener) = Unit

    /**
     * Resolves which app owns a connection passing through the tunnel.
     *
     * Never returns null. The engine asks this for every tunnelled connection —
     * `UsePlatformConnectionOwnerFinder` is hardcoded to true in the engine's Go
     * wrapper — and then reads the fields off the result there. A null here is a
     * nil-pointer panic that aborts the whole app (SIGABRT, Go `panic: runtime
     * error: invalid memory address` in `platformInterfaceWrapper.
     * FindConnectionOwner`) as soon as the tunnel carries its first packet, so
     * an unknown owner is reported with a negative uid instead.
     */
    override fun findConnectionOwner(
        ipProtocol: Int,
        sourceAddress: String,
        sourcePort: Int,
        destinationAddress: String,
        destinationPort: Int,
    ): ConnectionOwner {
        val owner = ConnectionOwner()
        val uid = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            runCatching {
                connectivityManager.getConnectionOwnerUid(
                    ipProtocol,
                    InetSocketAddress(sourceAddress, sourcePort),
                    InetSocketAddress(destinationAddress, destinationPort),
                )
            }.onFailure { Log.w(TAG, "getConnectionOwnerUid failed", it) }.getOrDefault(-1)
        } else {
            // Before Android 10 there is no supported way to attribute a socket;
            // the generated setters still have to be called, or Go reads an
            // unset field and panics the same way a null would.
            -1
        }
        owner.setUserId(uid)
        owner.setUserName("")
        owner.setProcessPath("")
        val packages = if (uid >= 0) {
            runCatching { packageManager.getPackagesForUid(uid)?.toList().orEmpty() }
                .onFailure { Log.w(TAG, "getPackagesForUid($uid) failed", it) }
                .getOrDefault(emptyList())
        } else {
            emptyList()
        }
        owner.setAndroidPackageNames(Strings(packages))
        return owner
    }

    private val connectivityManager: ConnectivityManager
        get() = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    override fun readWIFIState(): WIFIState? = null

    override fun localDNSTransport(): LocalDNSTransport = localDnsTransport

    private val localDnsTransport = object : LocalDNSTransport {
        private val rcodeNxDomain = 3

        override fun raw(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

        private fun resolvePhysicalNetwork(): Network {
            currentPhysicalNetwork?.let { return it }
            return findPhysicalNetwork(connectivityManager)?.also {
                currentPhysicalNetwork = it
            } ?: error("missing default physical network")
        }

        override fun exchange(ctx: ExchangeContext, message: ByteArray) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                error("raw local DNS exchange requires Android 10+")
            }
            if (dnsExecutor.isShutdown) {
                throw CancellationException("VPN service is shutting down")
            }
            exchangeApi29(resolvePhysicalNetwork(), ctx, message)
        }

        override fun lookup(ctx: ExchangeContext, network: String, domain: String) {
            if (dnsExecutor.isShutdown) {
                throw CancellationException("VPN service is shutting down")
            }
            val physical = resolvePhysicalNetwork()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                lookupApi29(physical, ctx, network, domain)
            } else {
                val answer = try {
                    physical.getAllByName(domain)
                } catch (_: UnknownHostException) {
                    ctx.errorCode(rcodeNxDomain)
                    return
                }
                ctx.success(answer.mapNotNull { it.hostAddress }.joinToString("\n"))
            }
        }
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun exchangeApi29(network: Network, ctx: ExchangeContext, message: ByteArray) {
        val latch = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        val signal = CancellationSignal()
        ctx.onCancel(object : LibboxFunc {
            override fun invoke() {
                signal.cancel()
                failure.compareAndSet(null, CancellationException("DNS query cancelled"))
                latch.countDown()
            }
        })
        val callback = object : DnsResolver.Callback<ByteArray> {
            override fun onAnswer(answer: ByteArray, rcode: Int) {
                if (rcode == 0) ctx.rawSuccess(answer) else ctx.errorCode(rcode)
                latch.countDown()
            }

            override fun onError(error: DnsResolver.DnsException) {
                val cause = error.cause
                if (cause is ErrnoException) {
                    ctx.errnoCode(cause.errno)
                } else {
                    failure.compareAndSet(null, error)
                }
                latch.countDown()
            }
        }
        DnsResolver.getInstance().rawQuery(
            network,
            message,
            DnsResolver.FLAG_NO_RETRY,
            dnsExecutor,
            signal,
            callback,
        )
        if (!latch.await(DNS_QUERY_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            signal.cancel()
            throw TimeoutException("local DNS query timed out")
        }
        failure.get()?.let { throw it }
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun lookupApi29(
        physical: Network,
        ctx: ExchangeContext,
        network: String,
        domain: String,
    ) {
        val latch = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        val signal = CancellationSignal()
        ctx.onCancel(object : LibboxFunc {
            override fun invoke() {
                signal.cancel()
                failure.compareAndSet(null, CancellationException("DNS lookup cancelled"))
                latch.countDown()
            }
        })
        val callback = object : DnsResolver.Callback<Collection<InetAddress>> {
            override fun onAnswer(answer: Collection<InetAddress>, rcode: Int) {
                if (rcode == 0) {
                    ctx.success(answer.mapNotNull { it.hostAddress }.joinToString("\n"))
                } else {
                    ctx.errorCode(rcode)
                }
                latch.countDown()
            }

            override fun onError(error: DnsResolver.DnsException) {
                val cause = error.cause
                if (cause is ErrnoException) {
                    ctx.errnoCode(cause.errno)
                } else {
                    failure.compareAndSet(null, error)
                }
                latch.countDown()
            }
        }
        val type = when {
            network.endsWith("4") -> DnsResolver.TYPE_A
            network.endsWith("6") -> DnsResolver.TYPE_AAAA
            else -> null
        }
        if (type != null) {
            DnsResolver.getInstance().query(
                physical,
                domain,
                type,
                DnsResolver.FLAG_NO_RETRY,
                dnsExecutor,
                signal,
                callback,
            )
        } else {
            DnsResolver.getInstance().query(
                physical,
                domain,
                DnsResolver.FLAG_NO_RETRY,
                dnsExecutor,
                signal,
                callback,
            )
        }
        if (!latch.await(DNS_QUERY_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            signal.cancel()
            throw TimeoutException("local DNS lookup timed out")
        }
        failure.get()?.let { throw it }
    }

    /** Android has no POSIX shell or bridge surface for the engine to use. */
    override fun usePlatformShell() = false

    override fun usePlatformBridge() = false

    override fun checkPlatformShell(): Unit = throw UnsupportedOperationException("platform shell is not supported on Android")

    override fun openShellSession(
        user: PlatformUser?,
        command: String,
        environ: StringIterator,
        term: String,
        rows: Int,
        cols: Int,
    ): ShellSession = throw UnsupportedOperationException("platform shell is not supported on Android")

    override fun lookupUser(username: String): PlatformUser? = null

    override fun lookupSFTPServer(): String = throw UnsupportedOperationException("SFTP is not supported on Android")

    override fun readSystemSSHHostKey(): String = throw UnsupportedOperationException("SSH host keys are not supported on Android")

    override fun createBridge(options: BridgeOptions): BridgeSession =
        throw UnsupportedOperationException("bridges are not supported on Android")

    /** A generated libbox string iterator over [values]. */
    private class Strings(private val values: List<String>) : StringIterator {
        private var index = -1
        override fun hasNext(): Boolean = index + 1 < values.size
        override fun len(): Int = values.size
        override fun next(): String = values.getOrElse(++index) { "" }
    }

    /** A generated libbox interface iterator over [items]. */
    private class NetworkInterfaces(private val items: List<NetworkInterface>) : NetworkInterfaceIterator {
        private var index = -1
        override fun hasNext(): Boolean = index + 1 < items.size
        override fun next(): NetworkInterface = items[++index]
    }
}

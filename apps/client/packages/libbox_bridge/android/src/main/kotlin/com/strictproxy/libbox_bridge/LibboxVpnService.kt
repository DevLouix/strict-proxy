package com.strictproxy.libbox_bridge

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.nekohasekai.libbox.BridgeOptions
import io.nekohasekai.libbox.BridgeSession
import io.nekohasekai.libbox.ConnectionOwner
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
import java.net.InetSocketAddress
import java.net.InterfaceAddress
import java.net.NetworkInterface as AndroidNetworkInterface

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
         * Set when the app asks for the tunnel to stop.
         *
         * A start intent can already be queued with Android when the stop
         * arrives; without this, the queued start would bring the tunnel back
         * up after the user asked for it to be down.
         */
        @Volatile
        private var stopRequested = false

        /**
         * The live service, so a stop can also be applied from inside it.
         *
         * `stopService` is the documented way to end a started service, but on
         * the device it twice left the service and its tun alive until Android
         * revoked the VPN from Settings — the user was told the VPN had not
         * shut down while the key stayed in the status bar. The instance can
         * close itself instead, which is the same teardown the system runs.
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
         * A service stop and not a broadcast: the system tears the service
         * down, so `onDestroy` runs even if this process is busy or the engine
         * is wedged, and the notification and the tun go with it. A broadcast
         * only reached a receiver that had to still be registered and alive in
         * this process, which is why Disconnect could leave the tunnel and its
         * notification running.
         */
        fun stop(context: Context) {
            stopRequested = true
            // Both results go to the on-device log: whether the system accepted
            // the stop is the first question a "did not shut down" report
            // needs answered, and it is invisible from the screen otherwise.
            val stopped = runCatching {
                context.stopService(Intent(context, LibboxVpnService::class.java))
            }.onFailure {
                EngineLog.append("stopService failed: ${it.javaClass.simpleName}: ${it.message}")
            }.getOrDefault(false)
            EngineLog.append("stopService returned $stopped")
            // Ask the service itself as well instead of trusting that call to
            // land. Warming it through an instance is safe whether or not the
            // system is already tearing it down: the teardown is idempotent.
            instance?.let { service ->
                service.main.post {
                    EngineLog.append("closing the tunnel from the service")
                    service.runner.stop()
                    service.stopSelf()
                }
            }
        }
    }

    private lateinit var runner: BoxRunner

    private val main = Handler(Looper.getMainLooper())

    /**
     * The engine's default-interface listeners, and the system callbacks that
     * feed them.
     *
     * The config sets `route.auto_detect_interface`, and on Android the engine
     * has no way to read the default route itself: the platform is expected to
     * report which interface currently carries traffic. Leaving these as no-ops
     * meant the engine had no default interface to bind outbound sockets to, so
     * the tunnel came up (`connected`) and then carried nothing — the exact
     * "connected but no internet" symptom. `getInterfaces()` alone is not a
     * substitute: it lists interfaces, it does not say which one is the path
     * out of the device.
     */
    private val defaultInterfaceCallbacks =
        HashMap<InterfaceUpdateListener, ConnectivityManager.NetworkCallback>()

    /** The physical network last reported to each listener. */
    private val reportedDefaultNetworks = HashMap<InterfaceUpdateListener, Network>()

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
        // Before the engine teardown: every stop confirmation reads this, and
        // the tun is gone by the time this callback runs.
        isRunning = false
        runner.destroy()
        super.onDestroy()
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
            for (server in TunPlan.dnsServers(strings { options.getDNSServerAddress() })) {
                builder.addDnsServer(server)
            }
            for (route in TunPlan.routes(prefixes { options.getInet4RouteAddress() }, "0.0.0.0", inet4.isNotEmpty())) {
                builder.addRoute(route.address, route.prefix)
            }
            for (route in TunPlan.routes(prefixes { options.getInet6RouteAddress() }, "::", inet6.isNotEmpty())) {
                builder.addRoute(route.address, route.prefix)
            }
        }

        val descriptor = builder.establish() ?: error("VpnService.Builder.establish returned null")
        // The descriptor is handed to libbox, which owns it from here on: the
        // engine closes it when the tun endpoint closes, including on reload.
        // Keeping the ParcelFileDescriptor as well and closing it here would
        // close an fd native code is still reading.
        return descriptor.detachFd()
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
     * The device's interfaces, shaped like the generated libbox iterator.
     *
     * Enumerated per call because libbox re-reads the list as networks change.
     * Every field is filled — the engine reads the iterators unconditionally,
     * and a null one is dereferenced in Go.
     */
    override fun getInterfaces(): NetworkInterfaceIterator {
        val interfaces = runCatching {
            AndroidNetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
        }.getOrDefault(emptyList())
        // An interface that cannot be represented is skipped: a malformed entry
        // (null iterator fields) would abort the Go side, while a short list is
        // just a less precise default-interface choice.
        val items = interfaces.mapNotNull { iface ->
            runCatching { libboxInterface(iface) }
                .onFailure { Log.w(TAG, "skipping interface ${iface.name}", it) }
                .getOrNull()
        }
        return NetworkInterfaces(items)
    }

    private fun libboxInterface(iface: AndroidNetworkInterface): NetworkInterface {
        val result = NetworkInterface()
        result.setName(iface.name)
        result.setIndex(iface.index)
        optional { result.setMTU(iface.mtu) }
        result.setFlags(interfaceFlags(iface))
        result.setType(interfaceType(iface))
        result.setMetered(false)
        result.setAddresses(Strings(iface.interfaceAddresses.mapNotNull { prefixString(it) }))
        result.setDNSServer(Strings(emptyList()))
        result.setGateway(Strings(emptyList()))
        return result
    }

    private inline fun optional(block: () -> Unit) {
        runCatching(block)
    }

    private fun prefixString(address: InterfaceAddress): String? {
        val inet = address.address ?: return null
        val host = inet.hostAddress?.substringBefore('%') ?: return null
        val max = if (inet.address.size == 4) 32 else 128
        val prefix = address.networkPrefixLength.toInt().coerceIn(0, max)
        return "$host/$prefix"
    }

    /**
     * Android's `java.net.NetworkInterface` has no flags getter, so the Go
     * `net.Flags` bits libbox expects are assembled from the public booleans.
     */
    private fun interfaceFlags(iface: AndroidNetworkInterface): Int {
        var flags = 0
        if (runCatching { iface.isUp }.getOrDefault(false)) flags = flags or 0x1 or 0x40 // UP | RUNNING
        if (runCatching { iface.isLoopback }.getOrDefault(false)) flags = flags or 0x8
        if (runCatching { iface.isPointToPoint }.getOrDefault(false)) flags = flags or 0x10
        if (runCatching { iface.supportsMulticast() }.getOrDefault(false)) flags = flags or 0x1000
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

    override fun startDefaultInterfaceMonitor(listener: InterfaceUpdateListener) {
        // registerDefaultNetworkCallback landed in Android 7. On older releases
        // the engine falls back to its own interface selection; there is no
        // supported way to observe the default network there.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        val manager = connectivityManager
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = reportDefaultInterface(manager, network, listener)

            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) =
                reportDefaultInterface(manager, network, listener)

            override fun onLost(network: Network) {
                // A VPN network going away must not wipe the physical interface
                // the engine is dialling through.
                if (reportedDefaultNetworks[listener] != network) return
                reportedDefaultNetworks.remove(listener)
                listener.updateDefaultInterface("", 0, false, false)
            }
        }
        defaultInterfaceCallbacks[listener] = callback
        runCatching { manager.registerDefaultNetworkCallback(callback) }
            .onFailure { Log.e(TAG, "could not monitor the default network", it) }
    }

    /**
     * Tells the engine which interface and index the default network uses.
     *
     * The metered flag matters: the engine avoids expensive paths for its own
     * connections when it can. The VPN flag matters more: without it, the tun
     * Android makes default is treated as a physical upstream and the engine
     * loops its own node connection back into the tunnel. A network announced
     * without a name is skipped rather than reported as an empty interface the
     * engine would bind to.
     */
    private fun reportDefaultInterface(
        manager: ConnectivityManager,
        network: Network,
        listener: InterfaceUpdateListener,
    ) {
        runCatching {
            val link = manager.getLinkProperties(network) ?: return
            val name = link.interfaceName ?: return
            val capabilities = manager.getNetworkCapabilities(network)
            val isVpn = capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
            val update = TunPlan.defaultInterfaceUpdate(name, isVpn) ?: return
            val index = AndroidNetworkInterface.getByName(update.name)?.index ?: 0
            val metered = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == false
            // The last argument is "this is a VPN". Reporting the tun with it
            // unset let the engine adopt its own tunnel as the upstream NIC,
            // because an Android VPN is only accepted as upstream when the
            // config asks for it (`route.override_android_vpn`). The result was
            // a connected tunnel that carried nothing on every app.
            listener.updateDefaultInterface(update.name, index, metered, update.isVpn)
            reportedDefaultNetworks[listener] = network
        }.onFailure { Log.w(TAG, "could not report the default interface", it) }
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

    override fun localDNSTransport(): LocalDNSTransport? = null

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

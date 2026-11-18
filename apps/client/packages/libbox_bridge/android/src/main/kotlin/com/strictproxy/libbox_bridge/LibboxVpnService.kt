package com.strictproxy.libbox_bridge

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.VpnService
import android.os.Build
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

        fun start(context: Context, config: String) {
            val intent = Intent(context, LibboxVpnService::class.java)
                .putExtra(BoxRunner.EXTRA_CONFIG, config)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }

        /**
         * Stops the tunnel and the service.
         *
         * `stopService` and not a broadcast: the system tears the service down,
         * so `onDestroy` runs even if this process is busy or the engine is
         * wedged, and the notification and the tun go with it. A broadcast only
         * reached a receiver that had to still be registered and alive in this
         * process, which is why Disconnect could leave the tunnel and its
         * notification running.
         */
        fun stop(context: Context) {
            context.stopService(Intent(context, LibboxVpnService::class.java))
        }
    }

    private lateinit var runner: BoxRunner

    override fun onCreate() {
        super.onCreate()
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

    override fun startDefaultInterfaceMonitor(listener: InterfaceUpdateListener) = Unit

    override fun closeDefaultInterfaceMonitor(listener: InterfaceUpdateListener) = Unit

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

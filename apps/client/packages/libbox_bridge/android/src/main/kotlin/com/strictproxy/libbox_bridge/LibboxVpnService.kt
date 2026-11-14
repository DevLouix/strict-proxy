package com.strictproxy.libbox_bridge

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.RemoteException
import android.util.Log
import androidx.core.app.NotificationCompat
import io.nekohasekai.libbox.BridgeOptions
import io.nekohasekai.libbox.BridgeSession
import io.nekohasekai.libbox.CommandServer
import io.nekohasekai.libbox.CommandServerHandler
import io.nekohasekai.libbox.ConnectionOwner
import io.nekohasekai.libbox.InterfaceUpdateListener
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.LocalDNSTransport
import io.nekohasekai.libbox.NeighborUpdateListener
import io.nekohasekai.libbox.NetworkInterface
import io.nekohasekai.libbox.NetworkInterfaceIterator
import io.nekohasekai.libbox.Notification as LibboxNotification
import io.nekohasekai.libbox.OverrideOptions
import io.nekohasekai.libbox.PlatformInterface
import io.nekohasekai.libbox.PlatformUser
import io.nekohasekai.libbox.RoutePrefixIterator
import io.nekohasekai.libbox.SetupOptions
import io.nekohasekai.libbox.ShellSession
import io.nekohasekai.libbox.StringIterator
import io.nekohasekai.libbox.SystemProxyStatus
import io.nekohasekai.libbox.TunOptions
import io.nekohasekai.libbox.WIFIState
import java.io.File
import java.net.InterfaceAddress
import java.net.NetworkInterface as AndroidNetworkInterface

/**
 * Foreground Android VPN service, bound to the engine's generated Java API.
 *
 * The libbox classes are a compile dependency (`libs/libbox-classes.jar`, built
 * from the pinned commit by `tool/build-libbox-aar.sh`), so an engine upgrade
 * that renames a callback or changes a signature fails the build here instead of
 * failing at runtime inside a `:vpn` process that Android then refuses to
 * restart. That is why this file implements the engine's interfaces directly
 * rather than answering them through reflection: [PlatformInterface] gained
 * seven callbacks and [TunOptions] replaced `getDNSServerAddress`'s StringBox
 * with an iterator between the previous artifact and the pin, and reflection
 * silently answered both with `null`. A null iterator is dereferenced in native
 * code and aborts the process.
 *
 * ## Lifetime
 *
 * The service outlives a single tunnel. Exactly one [CommandServer] is created
 * per process and every later connect goes through [CommandServer.startOrReloadService];
 * only `closeService()` is called on disconnect, never `close()`. The earlier
 * design created a server per connect and called `stopSelf()` on every
 * disconnect, which meant every reconnect re-entered the least-tested libbox
 * entry point in a brand-new process — and any native abort there makes Android
 * mark `:vpn` as a bad process and refuse to launch it again, so one failure
 * became permanent until the user force-stopped the app.
 *
 * State crosses to the app over a [Messenger] binder rather than package-scoped
 * broadcasts: binder death is immediate and unambiguous, where a broadcast
 * design has to infer death from missing heartbeats.
 */
class LibboxVpnService : VpnService(), PlatformInterface, CommandServerHandler {
    companion object {
        private const val TAG = "StrictProxyLibbox"
        private const val ACTION_START = "com.strictproxy.libbox.START"
        private const val ACTION_STOP = "com.strictproxy.libbox.STOP"
        private const val EXTRA_CONFIG = "config"
        private const val CHANNEL_ID = "strict_proxy_vpn"
        private const val NOTIFICATION_ID = 48118

        /** App -> service: stop the tunnel, keep the process and the engine. */
        const val MESSAGE_STOP = 1

        /** App -> service: what are you doing? Answered with [MESSAGE_STATE]. */
        const val MESSAGE_SYNC = 2

        /** Service -> app: the state carried in [EXTRA_STATE] and [EXTRA_MESSAGE]. */
        const val MESSAGE_STATE = 3

        const val EXTRA_STATE = "state"
        const val EXTRA_MESSAGE = "message"

        /**
         * `Libbox.setup` may run once per process: the Go side keeps global
         * state and aborts the process if it is initialised again.
         */
        private var enginePrepared = false

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
                .setAction(ACTION_START)
                .putExtra(EXTRA_CONFIG, config)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, LibboxVpnService::class.java).setAction(ACTION_STOP))
        }
    }

    /** The binder the app process talks to; alive for as long as this process. */
    private val serviceMessenger = Messenger(ServiceHandler())
    private var clientMessenger: Messenger? = null

    /**
     * The one CommandServer this process will ever create. Held across connects
     * on purpose: see the lifetime note on the class.
     */
    private var commandServer: CommandServer? = null

    private var engineRunning = false
    private var lastConfig: String? = null
    private var currentState = "disconnected"
    private var currentMessage: String? = null
    private var foreground = false

    /** Handles what the app process asks of this service. */
    private inner class ServiceHandler : Handler(Looper.getMainLooper()) {
        override fun handleMessage(msg: Message) {
            when (msg.what) {
                MESSAGE_STOP -> stopBox()
                MESSAGE_SYNC -> {
                    msg.replyTo?.let { clientMessenger = it }
                    sendState()
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopBox()
            ACTION_START -> {
                val config = intent.getStringExtra(EXTRA_CONFIG)
                when {
                    config.isNullOrBlank() -> fail("missing libbox configuration")
                    // A foreground service may only be announced here: the start
                    // request is the one moment Android allows it, and this is
                    // the only entry point that arrives from startForegroundService.
                    !enterForeground() -> fail("Android refused the VPN foreground service")
                    else -> startBox(config)
                }
            }
            // The system can restart a killed service with no intent. There is no
            // configuration to rebuild from, so there is nothing to do.
            else -> Unit
        }
        // The tunnel's lifetime is owned by the app's explicit start/stop, not by
        // whether this service happens to be running.
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = serviceMessenger.binder

    override fun onRevoke() {
        // Another VPN app took over, or consent was withdrawn in Settings. The
        // tun device is already gone, so the engine cannot be asked to close it
        // politely; what matters is that the app stops claiming to be connected.
        closeBox()
        lastConfig = null
        leaveForeground()
        emitState("error", "Another app took over the VPN, so StrictProxy stopped. Turn StrictProxy back on to reconnect.")
        super.onRevoke()
    }

    override fun onDestroy() {
        // The process is going away, so the engine cannot be reused: drop the
        // server as well as its service.
        closeBox()
        runCatching { commandServer?.close() }
        commandServer = null
        leaveForeground()
        emitState("disconnected")
        super.onDestroy()
    }

    // ---------------------------------------------------------------------
    // Tunnel lifecycle
    // ---------------------------------------------------------------------

    private fun startBox(config: String) {
        // A start while the same configuration is already up has nothing to do,
        // but it still has to answer: the app waits for a state and would
        // otherwise mistake the silence for a service that never launched.
        if (engineRunning && config == lastConfig) {
            emitState("connected")
            return
        }
        emitState("connecting")
        try {
            val server = commandServer ?: newCommandServer()
            // A different configuration (another node, for instance) is applied
            // in place: the tun device and the Go runtime stay up.
            server.startOrReloadService(config, OverrideOptions())
            engineRunning = true
            lastConfig = config
            emitState("connected")
        } catch (error: Throwable) {
            lastConfig = null
            closeBox()
            val cause = generateSequence(error) { it.cause }.last()
            fail(cause.message ?: "libbox failed to start")
        }
    }

    /**
     * Creates the process-wide command server and starts its control listener.
     *
     * `start()` binds the command socket once; every later connect only reloads
     * the service through [CommandServer.startOrReloadService].
     */
    private fun newCommandServer(): CommandServer {
        prepareEngine()
        val server = Libbox.newCommandServer(this, this)
        server.start()
        commandServer = server
        return server
    }

    private fun stopBox() {
        // Also clears a notification left behind by a start that failed after
        // the service had already announced itself as foreground.
        leaveForeground()
        if (!engineRunning) {
            lastConfig = null
            emitState("disconnected")
            return
        }
        emitState("disconnecting")
        closeBox()
        lastConfig = null
        emitState("disconnected")
    }

    /**
     * Ends the current tunnel but keeps this process, the engine and its command
     * server alive. Nothing here calls `stopSelf()`: a live process is the one
     * thing that prevents the "process is bad" state from making every later
     * connect fail.
     */
    private fun closeBox() {
        try {
            commandServer?.closeService()
        } catch (error: Throwable) {
            Log.w(TAG, "libbox closeService failed", error)
        }
        engineRunning = false
    }

    /**
     * `SetupOptions` carries the writable directories libbox needs before any
     * service exists, plus the values the engine reports in its own logs.
     */
    private fun prepareEngine() {
        if (enginePrepared) return
        val options = SetupOptions()
        val files = filesDir.absolutePath
        options.setBasePath(files)
        options.setWorkingPath(File(files, "libbox").apply { mkdirs() }.absolutePath)
        options.setTempPath(File(cacheDir, "libbox").apply { mkdirs() }.absolutePath)
        options.setLogMaxLines(300)
        options.setFixAndroidStack(true)
        val version = appVersion()
        options.setAppVersion(version)
        options.setAppMarketingVersion(version)
        Libbox.setup(options)
        enginePrepared = true
    }

    private fun appVersion(): String = runCatching {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "0.1.0"
    }.getOrDefault("0.1.0")

    private fun fail(message: String) {
        Log.e(TAG, message)
        lastConfig = null
        val announced = foreground
        leaveForeground()
        emitState("error", message)
        if (!announced) {
            // A startForegroundService request that never reaches
            // startForeground is an ANR the system will charge to this process
            // within seconds. Stopping is the only way out of it, and nothing is
            // running yet, so nothing is lost by doing it here.
            stopSelf()
        }
    }

    // ---------------------------------------------------------------------
    // State reporting
    // ---------------------------------------------------------------------

    private fun emitState(state: String, message: String? = null) {
        currentState = state
        currentMessage = message
        sendState()
        updateNotification()
    }

    /**
     * Sends the current state to the app. A missing receiver is normal: this
     * class lives in `:vpn` while the Flutter engine lives in the main process,
     * and the app asks for a sync (and therefore the current state) after it
     * binds.
     */
    private fun sendState() {
        val messenger = clientMessenger ?: return
        val message = Message.obtain(null, MESSAGE_STATE)
        message.data = Bundle().apply {
            putString(EXTRA_STATE, currentState)
            currentMessage?.let { putString(EXTRA_MESSAGE, it) }
        }
        try {
            messenger.send(message)
        } catch (error: RemoteException) {
            // The app process is gone. The tunnel is not: it keeps running and
            // the next bind asks for the state again.
            clientMessenger = null
            Log.w(TAG, "state receiver went away", error)
        }
    }

    // ---------------------------------------------------------------------
    // Notification
    // ---------------------------------------------------------------------

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "StrictProxy VPN", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    /**
     * Announces the service as foreground.
     *
     * Returns false instead of throwing: an FGS start Android refuses is a real
     * connect failure, and reporting it as a state the app can show is better
     * than an exception in `onStartCommand`, which the platform turns into a
     * crash and, for this process, a "process is bad" refusal on every retry.
     */
    private fun enterForeground(): Boolean = try {
        startForeground(NOTIFICATION_ID, notification())
        foreground = true
        true
    } catch (error: Throwable) {
        Log.e(TAG, "startForeground failed", error)
        false
    }

    private fun leaveForeground() {
        if (!foreground) return
        foreground = false
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        }
    }

    private fun updateNotification() {
        if (!foreground) return
        runCatching {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification())
        }
    }

    private fun notification() = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_sys_warning)
        .setContentTitle("StrictProxy")
        .setContentText(notificationText())
        .setStyle(NotificationCompat.BigTextStyle().bigText(notificationText()))
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(launchIntent())
        .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopIntent())
        .build()

    private fun notificationText(): String = when (currentState) {
        "connecting" -> "Connecting to the VPN…"
        "connected" -> "VPN connection active"
        "disconnecting" -> "Disconnecting…"
        "error" -> currentMessage ?: "The VPN stopped"
        else -> "Not connected"
    }

    private fun launchIntent(): PendingIntent? = packageManager.getLaunchIntentForPackage(packageName)?.let {
        PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun stopIntent(): PendingIntent = PendingIntent.getService(
        this,
        1,
        Intent(this, LibboxVpnService::class.java).setAction(ACTION_STOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    // ---------------------------------------------------------------------
    // CommandServerHandler: what libbox asks the host app to do
    // ---------------------------------------------------------------------

    override fun serviceStop() {
        stopBox()
    }

    /** The engine reloads itself; nothing for the host to do. */
    override fun serviceReload() = Unit

    /** Android has no system-wide proxy to report, so it is always disabled. */
    override fun getSystemProxyStatus(): SystemProxyStatus = SystemProxyStatus().apply {
        setAvailable(false)
        setEnabled(false)
    }

    override fun setSystemProxyEnabled(enabled: Boolean) = Unit

    override fun triggerNativeCrash() {
        Log.e(TAG, "libbox asked for a native crash")
    }

    override fun writeDebugMessage(message: String) {
        Log.d(TAG, message)
    }

    /** SSH agents are not implemented; the engine asks only when configured. */
    override fun connectSSHAgent(): Int = 0

    // ---------------------------------------------------------------------
    // PlatformInterface: what libbox calls to reach the device
    // ---------------------------------------------------------------------

    /**
     * Protects a socket the engine opened so its own traffic does not re-enter
     * the tunnel it just created.
     *
     * Throwing is correct: the Go side turns the error into a failed connection.
     * Returning quietly would leave that socket looping through the tunnel.
     */
    override fun autoDetectInterfaceControl(fd: Int) {
        if (!protect(fd)) throw IllegalStateException("VpnService.protect($fd) failed")
    }

    override fun openTun(options: TunOptions): Int {
        val builder = Builder().setSession("StrictProxy")
        val mtu = options.getMTU()
        if (mtu > 0) builder.setMtu(mtu)
        addAddresses(builder, options.getInet4Address())
        addAddresses(builder, options.getInet6Address())
        // Scoped IPv6 addresses carry a `%wlan0` suffix that a sing-box prefix
        // parser rejects, so the interface part is dropped.
        val dns = options.getDNSServerAddress()
        while (dns.hasNext()) {
            val server = dns.next().substringBefore('%')
            if (server.isNotBlank()) builder.addDnsServer(server)
        }
        if (options.getAutoRoute()) {
            addRoutes(builder, options.getInet4RouteAddress(), "0.0.0.0")
            addRoutes(builder, options.getInet6RouteAddress(), "::")
        }
        val descriptor = builder.establish() ?: error("VpnService.Builder.establish returned null")
        // The descriptor is handed to libbox, which owns it from here on: the
        // engine closes it when the tun endpoint closes, including on reload.
        // Keeping the ParcelFileDescriptor as well and closing it here would
        // close an fd native code is still reading — a double close, and a crash.
        return descriptor.detachFd()
    }

    private fun addAddresses(builder: Builder, prefixes: RoutePrefixIterator) {
        while (prefixes.hasNext()) {
            val prefix = prefixes.next()
            builder.addAddress(prefix.address(), prefix.prefix())
        }
    }

    /**
     * Adds the engine's routes, or a default route when it asked for none.
     *
     * An empty iterator with `auto_route` would otherwise leave the tunnel
     * without a route and the connection would come up dead.
     */
    private fun addRoutes(builder: Builder, prefixes: RoutePrefixIterator, fallback: String) {
        if (!prefixes.hasNext()) {
            builder.addRoute(fallback, 0)
            return
        }
        while (prefixes.hasNext()) {
            val prefix = prefixes.next()
            builder.addRoute(prefix.address(), prefix.prefix())
        }
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

    override fun findConnectionOwner(
        ipProtocol: Int,
        sourceAddress: String,
        sourcePort: Int,
        destinationAddress: String,
        destinationPort: Int,
    ): ConnectionOwner? = null

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

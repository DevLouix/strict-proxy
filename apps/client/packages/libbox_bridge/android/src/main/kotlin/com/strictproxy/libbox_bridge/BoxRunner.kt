package com.strictproxy.libbox_bridge

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import io.nekohasekai.libbox.CommandServer
import io.nekohasekai.libbox.CommandServerHandler
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.OverrideOptions
import io.nekohasekai.libbox.PlatformInterface
import io.nekohasekai.libbox.SetupOptions
import io.nekohasekai.libbox.SystemProxyStatus
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Runs the engine for one `VpnService` instance.
 *
 * This is a plain class rather than the service itself so the lifecycle is
 * readable in one place: announce the foreground notification, prepare the
 * engine, start or reload the tunnel, publish the state. The service subclass
 * only forwards Android's callbacks and answers [PlatformInterface], which is
 * how the engine's own Android client is laid out.
 *
 * Everything happens in the app's process. Two consequences matter, and both
 * replace machinery that used to misreport failures as "Android blocked the
 * VPN service": there is no binder whose death has to be distinguished from a
 * slow start, and [BoxStatus] listeners are ordinary in-process calls.
 */
internal class BoxRunner(
    private val service: LibboxVpnService,
    private val platform: PlatformInterface,
) : CommandServerHandler {
    companion object {
        private const val TAG = "StrictProxyLibbox"
        private const val CHANNEL_ID = "strict_proxy_vpn"
        private const val NOTIFICATION_ID = 48118

        /** App -> service: stop the tunnel and the service. */
        const val ACTION_STOP = "com.strictproxy.libbox.STOP"

        /** The sing-box configuration carried by the start intent. */
        const val EXTRA_CONFIG = "config"

        /**
         * `Libbox.setup` may run once per process: the Go side keeps global
         * state and aborts the process when it is initialised twice. A later
         * service instance in the same process must skip it.
         */
        private val enginePrepared = AtomicBoolean(false)
    }

    private val main = Handler(Looper.getMainLooper())

    /** One thread for start/stop, so a stop cannot overtake a start. */
    private val worker = Executors.newSingleThreadExecutor()

    /** The engine's command server; `null` until the first start. */
    private var commandServer: CommandServer? = null
    private var running = false
    private var lastConfig: String? = null
    private var foreground = false

    /**
     * Set when a stop was requested, so a start still running on [worker] cannot
     * bring the tunnel back up after the user asked for it to go down.
     */
    @Volatile private var stopRequested = false

    fun create() {
        createNotificationChannel()
    }

    /** A start intent arrived. */
    fun begin(config: String?) {
        // An explicit start is newer than any stop still in flight.
        stopRequested = false
        if (config.isNullOrBlank()) {
            fail("missing libbox configuration")
            return
        }
        // A start while the same configuration is already up has nothing to do,
        // but it still has to answer: the app waits for a state and would
        // otherwise read the silence as a refusal.
        if (running && config == lastConfig) {
            publish(BoxStatus.CONNECTED)
            return
        }
        // Android gives a service started with startForegroundService five
        // seconds to announce itself. Doing it before any engine work keeps a
        // slow or aborting engine from turning into an ANR.
        if (!enterForeground()) {
            fail("Android refused the VPN foreground service")
            return
        }
        publish(BoxStatus.CONNECTING)
        worker.execute { startEngine(config) }
    }

    private fun startEngine(config: String) {
        if (stopRequested) return
        try {
            val server = commandServer ?: newCommandServer()
            // A different configuration (another node, for instance) is applied
            // in place: the tun device and the Go runtime stay up.
            server.startOrReloadService(config, OverrideOptions())
            // A disconnect that arrived while the engine was starting wins: the
            // user asked for the tunnel to be down, not to come back. Publishing
            // CONNECTED here would also overwrite the state the UI already left.
            if (stopRequested) {
                closeService()
                return
            }
            running = true
            lastConfig = config
            publish(BoxStatus.CONNECTED)
        } catch (error: Throwable) {
            lastConfig = null
            val cause = generateSequence(error) { it.cause }.last()
            Log.e(TAG, "libbox failed to start", cause)
            closeService()
            fail(cause.message ?: "libbox failed to start")
        }
    }

    /**
     * Creates the process-wide command server and starts its control listener.
     * Every later connect only reloads the service through it.
     */
    private fun newCommandServer(): CommandServer {
        prepareEngine()
        val server = Libbox.newCommandServer(this, platform)
        server.start()
        commandServer = server
        return server
    }

    /**
     * `SetupOptions` carries the writable directories libbox needs before any
     * service exists, plus the values the engine reports in its own logs.
     */
    private fun prepareEngine() {
        if (enginePrepared.get()) return
        synchronized(enginePrepared) {
            if (enginePrepared.get()) return
            val options = SetupOptions()
            val files = service.filesDir.absolutePath
            options.setBasePath(files)
            options.setWorkingPath(File(files, "libbox").apply { mkdirs() }.absolutePath)
            options.setTempPath(File(service.cacheDir, "libbox").apply { mkdirs() }.absolutePath)
            options.setLogMaxLines(300)
            options.setFixAndroidStack(true)
            val version = appVersion()
            options.setAppVersion(version)
            options.setAppMarketingVersion(version)
            Libbox.setup(options)
            enginePrepared.set(true)
        }
    }

    private fun appVersion(): String = runCatching {
        service.packageManager.getPackageInfo(service.packageName, 0).versionName ?: "0.1.0"
    }.getOrDefault("0.1.0")

    /**
     * User asked to disconnect, from the app or the notification.
     *
     * The visible teardown happens before and independently of the engine: the
     * notification and the service have to go away even if closing the engine is
     * slow or stuck. The engine is closed by [destroy] when the service stops,
     * rather than before `stopSelf`, so a close that never returns cannot keep
     * the tunnel (and the device's traffic) up.
     */
    fun stop() {
        stopRequested = true
        lastConfig = null
        main.post {
            leaveForeground()
            publish(BoxStatus.DISCONNECTED)
            service.stopSelf()
        }
    }

    /** Another app took over the VPN, or consent was withdrawn in Settings. */
    fun revoke() {
        worker.execute {
            closeService()
            lastConfig = null
            main.post {
                leaveForeground()
                publish(
                    BoxStatus.ERROR,
                    "Another app took over the VPN, so StrictProxy stopped. Turn StrictProxy back on to reconnect.",
                )
                service.stopSelf()
            }
        }
    }

    fun destroy() {
        stopRequested = true
        running = false
        // Main-thread work first: the notification must not outlive the stop.
        leaveForeground()
        publish(BoxStatus.DISCONNECTED)
        // Closing the engine can wait on the Go side, and blocking `onDestroy` is
        // an ANR at exactly the moment the tunnel is supposed to disappear. The
        // worker is drained instead of interrupted so the queued close still runs.
        // A command server created for this service cannot be reused by the next
        // one, which builds its own.
        val closing = commandServer
        commandServer = null
        runCatching {
            worker.execute {
                runCatching { closing?.closeService() }
                    .onFailure { Log.w(TAG, "libbox closeService failed", it) }
                runCatching { closing?.close() }
                    .onFailure { Log.w(TAG, "libbox command server close failed", it) }
            }
            worker.shutdown()
        }
    }

    /**
     * Ends the current tunnel but keeps the engine and its command server so
     * the next connect is a reload rather than a cold start.
     */
    private fun closeService() {
        running = false
        runCatching { commandServer?.closeService() }
            .onFailure { Log.w(TAG, "libbox closeService failed", it) }
    }

    private fun fail(message: String) {
        Log.e(TAG, message)
        lastConfig = null
        closeService()
        main.post {
            val announced = foreground
            leaveForeground()
            publish(BoxStatus.ERROR, message)
            if (!announced) {
                // A startForegroundService request that never reaches
                // startForeground is an ANR the system charges to this process
                // within seconds. Stopping is the only way out of it.
                service.stopSelf()
            }
        }
    }

    private fun publish(state: String, message: String? = null) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            BoxStatus.update(state, message)
        } else {
            main.post { BoxStatus.update(state, message) }
        }
    }

    // ---------------------------------------------------------------------
    // Notification
    // ---------------------------------------------------------------------

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            service.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "StrictProxy VPN", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    /**
     * Announces the service as foreground.
     *
     * Returns false instead of throwing: a foreground start Android refuses is
     * a connect failure the app can show, not a reason to crash.
     */
    private fun enterForeground(): Boolean = try {
        service.startForeground(NOTIFICATION_ID, notification())
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
                service.stopForeground(android.app.Service.STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                service.stopForeground(true)
            }
        }
    }

    private fun updateNotification() {
        if (!foreground) return
        runCatching {
            service.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification())
        }
    }

    private fun notification() = NotificationCompat.Builder(service, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_sys_warning)
        .setContentTitle("StrictProxy")
        .setContentText(notificationText())
        .setStyle(NotificationCompat.BigTextStyle().bigText(notificationText()))
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(launchIntent())
        .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopIntent())
        .build()

    private fun notificationText(): String = when (BoxStatus.state) {
        BoxStatus.CONNECTING -> "Connecting to the VPN…"
        BoxStatus.CONNECTED -> "VPN connection active"
        BoxStatus.DISCONNECTING -> "Disconnecting…"
        BoxStatus.ERROR -> BoxStatus.message ?: "The VPN stopped"
        else -> "Not connected"
    }

    /**
     * Immutability is mandatory from Android 12 and unknown before Android 6,
     * where `PendingIntent` rejects flags it does not recognise.
     */
    private val pendingFlags: Int
        get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0

    private fun launchIntent(): PendingIntent? = service.packageManager
        .getLaunchIntentForPackage(service.packageName)
        ?.let { PendingIntent.getActivity(service, 0, it, pendingFlags or PendingIntent.FLAG_UPDATE_CURRENT) }

    /**
     * The notification's Stop action. A service intent, not a broadcast: the
     * service receives it through `onStartCommand` whether or not a runtime
     * receiver happens to be registered in this process.
     */
    private fun stopIntent(): PendingIntent = PendingIntent.getService(
        service,
        1,
        Intent(service, LibboxVpnService::class.java).setAction(ACTION_STOP),
        pendingFlags or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    // ---------------------------------------------------------------------
    // CommandServerHandler: what libbox asks the host app to do
    // ---------------------------------------------------------------------

    override fun serviceStop() = stop()

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
        updateNotification()
    }

    /** SSH agents are not implemented; the engine asks only when configured. */
    override fun connectSSHAgent(): Int = 0
}

package __PACKAGE__

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

/**
 * Hosts the in-app updater and the device facts the Dart side needs.
 *
 * This file is a tracked template, not a generated one: `apps/client/android/`
 * is recreated by `flutter create` on every clean checkout, so
 * `tool/configure-android-host.sh` writes this over the generated activity. If
 * the updater lived only in the generated tree, a released APK would compile
 * fine and then fail at runtime with a missing method channel.
 *
 * Android only replaces an installed app with an APK signed by the same key, so
 * the package manager is the integrity check for the download; it also refuses
 * to downgrade, which is why the controller publishes a monotonically
 * increasing build number.
 */
class MainActivity : FlutterActivity() {
    companion object {
        private const val UPDATER_CHANNEL = "strict_proxy/updater"
        private const val DEVICE_CHANNEL = "strict_proxy/device"

        // ApplicationExitInfo reason codes. The constants themselves only exist
        // from API 30, so they are spelled out here.
        private const val EXIT_LOW_MEMORY = 3
        private const val EXIT_CRASH = 4
        private const val EXIT_CRASH_NATIVE = 5
        private const val EXIT_ANR = 6

        /** Exits read back, so one ordinary shutdown does not hide a crash. */
        private const val EXIT_HISTORY = 8

        /** Tombstone head kept for the report: the signal and the first frames. */
        private const val TRACE_LIMIT = 2_000
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        // What the Dart side needs to pick the right APK and describe a crash:
        // the CPU ABIs (most preferred first), the device model and the OS.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, DEVICE_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "info" -> result.success(
                        mapOf(
                            "abis" to Build.SUPPORTED_ABIS.toList(),
                            "model" to Build.MODEL,
                            "manufacturer" to Build.MANUFACTURER,
                            "osVersion" to Build.VERSION.RELEASE,
                        ),
                    )
                    "lastCrash" -> result.success(lastCrash())
                    else -> result.notImplemented()
                }
            }

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, UPDATER_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "cacheDir" -> result.success(cacheDir.absolutePath)
                    "install" -> {
                        val path = call.argument<String>("path")
                        if (path.isNullOrBlank()) {
                            result.error("invalid_path", "An APK path is required", null)
                            return@setMethodCallHandler
                        }
                        result.success(openInstaller(File(path)))
                    }
                    else -> result.notImplemented()
                }
            }
    }

    /**
     * Why the previous process died, when it was a crash.
     *
     * A native SIGSEGV never reaches Dart's error handlers: the process is gone
     * before any Dart code can run. Android records the exit reason against the
     * package, so the next launch reports it through the same crash endpoint the
     * dashboard already lists.
     *
     * The engine shares this process, so a native abort is recorded against this
     * package and is indistinguishable from a Dart crash except by its reason
     * (`crash_native`). The tombstone head travels with the report: without it a
     * native abort is only ever "the app crashed", with no signal and no
     * aborting frame to act on.
     *
     * Read reflectively because `ApplicationExitInfo` and its accessors only exist
     * from API 30 while this host also compiles for older platforms. Null means
     * either the platform is too old or the recent exits were ordinary ones.
     */
    private fun lastCrash(): Map<String, Any?>? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return try {
            val manager = getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return null
            val exits = ActivityManager::class.java
                .getMethod(
                    "getHistoricalProcessExitReasons",
                    String::class.java,
                    Int::class.javaPrimitiveType,
                    Int::class.javaPrimitiveType,
                )
                .invoke(manager, packageName, 0, EXIT_HISTORY) as? List<*> ?: return null
            // Newest first, as Android returns them.
            val crashes = exits.mapNotNull { info -> info?.let { exitOf(it) } }
            crashes.firstOrNull()?.toMap()
        } catch (_: Throwable) {
            // Reading exit history is diagnostics, never a reason to fail a launch.
            null
        }
    }

    /** One recorded exit, kept only when it is a crash the app can learn from. */
    private class Exit(
        val process: String,
        val reason: String,
        val timestamp: Long,
        val description: String?,
        val trace: String?,
    ) {
        fun toMap(): Map<String, Any?> = mapOf(
            "reason" to reason,
            "timestamp" to timestamp,
            "description" to description,
            "process" to process,
            "trace" to trace,
        )
    }

    /** [info] as an [Exit], or null when it was an ordinary shutdown. */
    private fun exitOf(info: Any): Exit? {
        val process = runCatching {
            info.javaClass.getMethod("getProcessName").invoke(info) as? String
        }.getOrNull() ?: packageName
        val reason = when (info.javaClass.getMethod("getReason").invoke(info) as? Int) {
            EXIT_CRASH_NATIVE -> "crash_native"
            EXIT_CRASH -> "crash"
            EXIT_ANR -> "anr"
            EXIT_LOW_MEMORY -> "low_memory"
            // USER_REQUESTED, EXIT_SELF and friends are ordinary shutdowns.
            else -> return null
        }
        return Exit(
            process = process,
            reason = reason,
            timestamp = (info.javaClass.getMethod("getTimestamp").invoke(info) as? Number)?.toLong() ?: 0L,
            description = runCatching {
                info.javaClass.getMethod("getDescription").invoke(info) as? String
            }.getOrNull(),
            trace = runCatching { traceHead(info) }.getOrNull(),
        )
    }

    /**
     * The first lines of the recorded tombstone or ANR trace.
     *
     * Bounded on purpose: this is sent as a crash report, and the signal plus the
     * aborting frame are in the first few lines.
     */
    private fun traceHead(info: Any): String? {
        val stream = info.javaClass.getMethod("getTraceInputStream").invoke(info) as? java.io.InputStream
        if (stream == null) return null
        return stream.use {
            val buffer = ByteArray(TRACE_LIMIT)
            var read = 0
            while (read < buffer.size) {
                val count = it.read(buffer, read, buffer.size - read)
                if (count <= 0) break
                read += count
            }
            String(buffer, 0, read, Charsets.UTF_8).trim().ifEmpty { null }
        }
    }

    /**
     * Opens the system installer for [apk].
     *
     * Returns false when the user must first allow installs for this app; the
     * caller then explains that instead of pretending the update started.
     */
    private fun openInstaller(apk: File): Boolean {
        if (!apk.isFile || apk.length() == 0L) return false

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !packageManager.canRequestPackageInstalls()
        ) {
            startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")),
            )
            return false
        }

        val uri = FileProvider.getUriForFile(this, "$packageName.updates", apk)
        startActivity(
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            },
        )
        return true
    }
}

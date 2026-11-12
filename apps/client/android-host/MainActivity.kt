package __PACKAGE__

import android.app.ActivityManager
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
     * package, so the next launch can report it through the same crash endpoint
     * the dashboard already lists. Null means either the platform is too old
     * (below Android 11) or the last exit was a normal one.
     */
    private fun lastCrash(): Map<String, Any?>? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return try {
            val manager = getSystemService(ActivityManager::class.java) ?: return null
            val info = manager.getHistoricalProcessExitReasons(packageName, 0, 1).firstOrNull() ?: return null
            val reason = when (info.reason) {
                ActivityManager.ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash_native"
                ActivityManager.ApplicationExitInfo.REASON_CRASH -> "crash"
                ActivityManager.ApplicationExitInfo.REASON_ANR -> "anr"
                ActivityManager.ApplicationExitInfo.REASON_LOW_MEMORY -> "low_memory"
                // USER_REQUESTED, EXIT_SELF and friends are ordinary shutdowns.
                else -> return null
            }
            mapOf(
                "reason" to reason,
                "timestamp" to info.timestamp,
                "description" to info.description,
            )
        } catch (_: Throwable) {
            // Reading exit history is diagnostics, never a reason to fail a launch.
            null
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

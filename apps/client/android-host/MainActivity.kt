package __PACKAGE__

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

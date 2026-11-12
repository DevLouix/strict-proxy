import 'dart:io';

import 'app_version.dart';
import 'config.dart';
import 'crash_reporter.dart';
import 'device_info.dart';

/// Builds and sends a user-triggered diagnostics report.
///
/// A native abort leaves nothing Dart can catch, so the phone is the only place
/// that knows what happened. Rather than asking someone to read logcat, the
/// account screen sends the facts an operator needs through the same endpoint
/// the crash table already reads.
class Diagnostics {
  /// Sends one report. Returns null on success, or a message to show the user.
  static Future<String?> send({
    required String engine,
    String? engineMessage,
  }) async {
    final device = await DeviceInfo.load();
    final exit = await CrashReporter.lastExit();
    final abis = device?.abis ?? const <String>[];

    final sent = await CrashReporter.sendDiagnostics({
      'build': '${AppVersion.name} (${AppVersion.buildNumber})',
      'osVersion': device?.osVersion ?? Platform.operatingSystemVersion,
      'device': device?.label,
      'abi': abis.isEmpty ? null : abis.first,
      'engine': engine,
      'engineMessage': engineMessage,
      'lastExitReason': exit?['reason'],
      'lastExitAt': exit?['timestamp'],
      'controllerUrl': AppConfig.controllerUrl,
    });

    return sent
        ? null
        : 'Could not reach the controller. Check your connection and try again.';
  }
}

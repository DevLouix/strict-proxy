import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'app_version.dart';
import 'config.dart';
import 'device_info.dart';

/// Sends uncaught client errors to the controller, where the admin dashboard
/// lists them.
///
/// This exists because a crash on the home screen was invisible: the app died
/// on the device and the operator had nothing to read. Reports are
/// best-effort — the reporter never throws, never blocks the UI and never
/// recurses into itself, because a crash during error reporting must not become
/// a second crash. A controller that is unreachable simply means the report is
/// lost; connecting keeps working.
class CrashReporter {
  /// Caps the work one session can do: an error inside a build loop can fire
  /// thousands of times, and none of the copies would be more useful than the
  /// first one.
  static const _maxReportsPerSession = 10;
  static const _timeout = Duration(seconds: 8);

  static final Set<String> _reported = <String>{};
  static bool _installed = false;

  /// Routes [FlutterError.onError] through the reporter.
  ///
  /// Call once, after the binding is initialised. The previous handler still
  /// runs, so the console output behind `adb logcat` is unchanged.
  static void install() {
    if (_installed) return;
    _installed = true;

    final previous = FlutterError.onError;
    FlutterError.onError = (details) {
      (previous ?? FlutterError.presentError)(details);
      unawaited(report(
        details.exceptionAsString(),
        details.stack,
        context: {
          'handler': 'FlutterError',
          'library': details.library,
          'context': details.context?.toDescription(),
        },
      ));
    };
  }

  /// Best-effort delivery. Never throws.
  static Future<void> report(
    String message,
    StackTrace? stack, {
    bool fatal = false,
    Map<String, Object?>? context,
  }) async {
    try {
      final key = '$message|${stack?.toString().split('\n').take(3).join('|') ?? ''}';
      if (_reported.length >= _maxReportsPerSession || !_reported.add(key)) return;

      final device = await DeviceInfo.load();
      final payload = <String, Object?>{
        'reportId': _reportId(),
        'platform': Platform.operatingSystem,
        'appVersion': AppVersion.name,
        'buildNumber': AppVersion.buildNumber,
        'abi': device == null || device.abis.isEmpty ? null : device.abis.first,
        'device': device?.label,
        'osVersion': device?.osVersion ?? Platform.operatingSystemVersion,
        'message': message,
        'stack': stack?.toString(),
        'context': <String, Object?>{
          'fatal': fatal,
          'releaseMode': kReleaseMode,
          ...?context,
        },
      };

      await http
          .post(
            Uri.parse('${AppConfig.controllerUrl}/api/v1/client/crashes'),
            headers: const {'content-type': 'application/json'},
            body: jsonEncode(payload),
          )
          .timeout(_timeout);
    } catch (_) {
      // A report that cannot be delivered must not affect the app.
    }
  }

  static String _reportId() {
    final now = DateTime.now().microsecondsSinceEpoch;
    final random = Random().nextInt(0x7fffffff).toRadixString(36);
    return 'crash-$now-$random';
  }
}

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
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
  static const _deviceChannel = MethodChannel('strict_proxy/device');

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
      report(
        details.exceptionAsString(),
        details.stack,
        context: {
          'handler': 'FlutterError',
          'library': details.library,
          'context': details.context?.toDescription(),
        },
      ).ignore();
    };
  }

  /// The exit Android recorded for the previous launch, when it was a crash.
  static Future<Map<String, Object?>?> lastExit() async {
    try {
      final info = await _deviceChannel.invokeMapMethod<String, Object?>('lastCrash');
      return info == null ? null : Map<String, Object?>.from(info);
    } catch (_) {
      // No host (desktop, tests) or no exit history.
      return null;
    }
  }

  /// A user-triggered report, sent through the same endpoint as crashes.
  static Future<bool> sendDiagnostics(Map<String, Object?> details) => report(
        'Diagnostics report from ${details['device'] ?? 'this device'}',
        null,
        context: {'kind': 'diagnostics', ...details},
      );

  /// Reports the previous process's crash, when Android recorded one.
  ///
  /// A native crash inside the VPN engine kills the process before Dart can
  /// observe it, which is exactly the failure that used to be invisible. The
  /// host reports the recorded exit on the next launch and the same endpoint
  /// stores it, so it lands in the dashboard beside Flutter errors.
  static Future<void> reportPreviousExit() async {
    try {
      final info = await lastExit();
      if (info == null) return;
      final timestamp = (info['timestamp'] as num?)?.toInt() ?? 0;
      if (timestamp <= 0) return;
      final reason = info['reason'] as String? ?? 'crash';
      final description = (info['description'] as String?)?.trim() ?? '';
      await report(
        'Process exited: $reason${description.isEmpty ? '' : ' — $description'}',
        null,
        fatal: true,
        reportId: 'exit-$timestamp',
        context: {
          'handler': 'ApplicationExitInfo',
          'reason': reason,
          'exitTimestamp': timestamp,
        },
      );
    } catch (_) {
      // No host (desktop, tests) or no exit history: nothing to report.
    }
  }

  /// Best-effort delivery. Never throws.
  static Future<bool> report(
    String message,
    StackTrace? stack, {
    bool fatal = false,
    Map<String, Object?>? context,
    String? reportId,
  }) async {
    try {
      final key = '$message|${stack?.toString().split('\n').take(3).join('|') ?? ''}';
      if (_reported.length >= _maxReportsPerSession || !_reported.add(key)) return false;

      final device = await DeviceInfo.load();
      final payload = <String, Object?>{
        // A caller that already has a stable id (a recorded process exit) passes
        // it, so reopening the app does not file the same crash twice.
        'reportId': reportId ?? _reportId(),
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

      final res = await http
          .post(
            Uri.parse('${AppConfig.controllerUrl}/api/v1/client/crashes'),
            headers: const {'content-type': 'application/json'},
            body: jsonEncode(payload),
          )
          .timeout(_timeout);
      return res.statusCode < 400;
    } catch (_) {
      // A report that cannot be delivered must not affect the app.
      return false;
    }
  }

  static String _reportId() {
    final now = DateTime.now().microsecondsSinceEpoch;
    final random = Random().nextInt(0x7fffffff).toRadixString(36);
    return 'crash-$now-$random';
  }
}

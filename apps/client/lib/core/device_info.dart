import 'package:flutter/services.dart';

/// What the platform reports about this device.
///
/// Used for two decisions that must agree: which APK an update downloads, and
/// which ABI a crash report came from. Values come from the Android host over a
/// method channel; on desktop and in widget tests there is no host, so [load]
/// answers null rather than failing.
class DeviceInfo {
  const DeviceInfo({
    required this.abis,
    this.model,
    this.manufacturer,
    this.osVersion,
  });

  /// `Build.SUPPORTED_ABIS`, most preferred first (e.g. `arm64-v8a`).
  final List<String> abis;
  final String? model;
  final String? manufacturer;
  final String? osVersion;

  static const _channel = MethodChannel('strict_proxy/device');

  static DeviceInfo? _cached;
  static bool _loaded = false;

  static Future<DeviceInfo?> load() async {
    if (_loaded) return _cached;
    _loaded = true;
    try {
      final raw = await _channel.invokeMapMethod<String, Object?>('info');
      if (raw == null) return null;
      final abis = (raw['abis'] as List<Object?>?)
              ?.whereType<String>()
              .toList(growable: false) ??
          const <String>[];
      _cached = DeviceInfo(
        abis: abis,
        model: raw['model'] as String?,
        manufacturer: raw['manufacturer'] as String?,
        osVersion: raw['osVersion'] as String?,
      );
      return _cached;
    } catch (_) {
      // No host implementation (desktop, tests): not an error.
      return null;
    }
  }

  /// A short human label for crash reports, e.g. `Google Pixel 7`.
  String get label {
    final parts = [manufacturer, model]
        .whereType<String>()
        .map((part) => part.trim())
        .where((part) => part.isNotEmpty)
        .toList(growable: false);
    return parts.isEmpty ? 'unknown device' : parts.join(' ');
  }
}

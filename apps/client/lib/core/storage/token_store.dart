import 'dart:math';
import 'package:shared_preferences/shared_preferences.dart';

/// Persists tokens and the installation device id.
///
/// Backed by SharedPreferences for portability; swap the storage layer for
/// flutter_secure_storage in hardened production builds.
class TokenStore {
  static const _kAccess = 'sp.access';
  static const _kRefresh = 'sp.refresh';
  static const _kDeviceId = 'sp.deviceId';
  static const _kDeviceName = 'sp.deviceName';

  /// In-memory mirror, populated by [load] and kept in sync by [saveTokens].
  String? accessToken;
  String? refreshToken;

  /// Returns the stable installation device id, creating one on first run.
  Future<String> ensureDeviceIdentity({String? deviceName}) async {
    final prefs = await SharedPreferences.getInstance();
    var id = prefs.getString(_kDeviceId);
    if (id == null || id.isEmpty) {
      id = _generateId();
      await prefs.setString(_kDeviceId, id);
    }
    if (deviceName != null && deviceName.isNotEmpty) {
      await prefs.setString(_kDeviceName, deviceName);
    }
    return id;
  }

  Future<String?> get deviceId async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_kDeviceId);
  }

  Future<String?> get deviceName async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_kDeviceName);
  }

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    accessToken = prefs.getString(_kAccess);
    refreshToken = prefs.getString(_kRefresh);
  }

  Future<void> saveTokens({String? accessToken, String? refreshToken}) async {
    final prefs = await SharedPreferences.getInstance();
    if (accessToken != null) {
      this.accessToken = accessToken;
      await prefs.setString(_kAccess, accessToken);
    }
    if (refreshToken != null) {
      this.refreshToken = refreshToken;
      await prefs.setString(_kRefresh, refreshToken);
    }
  }

  Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kAccess);
    await prefs.remove(_kRefresh);
    accessToken = null;
    refreshToken = null;
  }

  /// 128-bit random identifier, hex formatted like a UUID for familiarity.
  String _generateId() {
    final rnd = Random.secure();
    final bytes = List<int>.generate(16, (_) => rnd.nextInt(256));
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
        '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }
}

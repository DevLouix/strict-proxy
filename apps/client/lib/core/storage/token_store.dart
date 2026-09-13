import 'dart:math';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Persists authentication tokens in OS secure storage and the installation
/// identity in preferences. Tokens never live in plain SharedPreferences.
class TokenStore {
  static const _kAccess = 'sp.access';
  static const _kRefresh = 'sp.refresh';
  static const _kDeviceId = 'sp.deviceId';
  static const _kDeviceName = 'sp.deviceName';

  final FlutterSecureStorage _secure = const FlutterSecureStorage();
  String? accessToken;
  String? refreshToken;

  Future<String> ensureDeviceIdentity({String? deviceName}) async {
    final prefs = await SharedPreferences.getInstance();
    var id = prefs.getString(_kDeviceId);
    if (id == null || id.isEmpty) {
      id = _generateId();
      await prefs.setString(_kDeviceId, id);
    }
    if (deviceName != null && deviceName.isNotEmpty) await prefs.setString(_kDeviceName, deviceName);
    return id;
  }

  Future<String?> get deviceId async => (await SharedPreferences.getInstance()).getString(_kDeviceId);
  Future<String?> get deviceName async => (await SharedPreferences.getInstance()).getString(_kDeviceName);

  Future<void> load() async {
    accessToken = await _secure.read(key: _kAccess);
    refreshToken = await _secure.read(key: _kRefresh);
  }

  Future<void> saveTokens({String? accessToken, String? refreshToken}) async {
    if (accessToken != null) {
      this.accessToken = accessToken;
      await _secure.write(key: _kAccess, value: accessToken);
    }
    if (refreshToken != null) {
      this.refreshToken = refreshToken;
      await _secure.write(key: _kRefresh, value: refreshToken);
    }
  }

  Future<void> clear() async {
    await _secure.delete(key: _kAccess);
    await _secure.delete(key: _kRefresh);
    accessToken = null;
    refreshToken = null;
  }

  String _generateId() {
    final rnd = Random.secure();
    final bytes = List<int>.generate(16, (_) => rnd.nextInt(256));
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
        '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }
}

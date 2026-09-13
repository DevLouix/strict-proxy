import 'dart:convert';
import 'package:http/http.dart' as http;

import 'config.dart';
import 'storage/token_store.dart';

class ApiException implements Exception {
  ApiException(this.statusCode, this.code, this.message);
  final int statusCode;
  final String code;
  final String message;

  @override
  String toString() => 'ApiException($statusCode, $code, $message)';
}

/// Typed client for the Central Controller's public API.
class ControllerApi {
  ControllerApi({http.Client? client, TokenStore? tokens})
      : _client = client ?? http.Client(),
        _tokens = tokens ?? TokenStore();

  final http.Client _client;
  final TokenStore _tokens;

  TokenStore get tokens => _tokens;

  Uri _uri(String path) {
    final base = Uri.parse(AppConfig.controllerUrl);
    return base.resolve(path.startsWith('/') ? path.substring(1) : path);
  }

  Map<String, String> _headers({bool auth = true}) => {
        'content-type': 'application/json',
        if (auth && _tokens.accessToken != null)
          'authorization': 'Bearer ${_tokens.accessToken}',
      };

  Future<http.Response> _request(
    Future<http.Response> Function() fn,
  ) async {
    try {
      return await fn().timeout(AppConfig.requestTimeout);
    } on FormatException {
      rethrow;
    } catch (error) {
      throw ApiException(0, 'NETWORK_ERROR', 'Controller request failed: $error');
    }
  }

  Future<Map<String, dynamic>> _send(
    Future<http.Response> Function() fn, {
    bool retryOn401 = true,
  }) async {
    final res = await _request(fn);
    if (res.statusCode == 401 && retryOn401) {
      final refreshed = await tryRefresh();
      if (refreshed) return _send(fn, retryOn401: false);
    }

    final decoded = res.bodyBytes.isEmpty
        ? <String, dynamic>{}
        : jsonDecode(utf8.decode(res.bodyBytes));
    final body = decoded is Map<String, dynamic>
        ? decoded
        : <String, dynamic>{'data': decoded};
    if (res.statusCode >= 400) {
      throw ApiException(
        res.statusCode,
        (body['code'] as String?) ?? 'UNKNOWN',
        (body['error'] as String?) ?? 'request failed',
      );
    }
    return body;
  }

  Future<Map<String, dynamic>> register(String email, String password) {
    return _send(() => _client.post(
          _uri('/api/v1/auth/register'),
          headers: _headers(auth: false),
          body: jsonEncode({'email': email, 'password': password}),
        ));
  }

  Future<Map<String, dynamic>> login(
      String email, String password, String deviceId, String deviceName) {
    return _send(() => _client.post(
          _uri('/api/v1/auth/login'),
          headers: _headers(auth: false),
          body: jsonEncode({
            'email': email,
            'password': password,
            'deviceId': deviceId,
            'deviceName': deviceName,
          }),
        ));
  }

  Future<Map<String, dynamic>> refresh(String refreshToken, String deviceId) {
    return _send(
      () => _client.post(
        _uri('/api/v1/auth/refresh'),
        headers: _headers(auth: false),
        body: jsonEncode({'refreshToken': refreshToken, 'deviceId': deviceId}),
      ),
      retryOn401: false,
    );
  }

  Future<Map<String, dynamic>> me() =>
      _send(() => _client.get(_uri('/api/v1/me'), headers: _headers()));

  /// Signed dynamic sing-box config bundle (per-node VLESS+REALITY).
  Future<Map<String, dynamic>> networkConfig() =>
      _send(() => _client.get(_uri('/api/v1/network/config'), headers: _headers()));

  /// Attempts a token refresh; true when a fresh access token is available.
  Future<bool> tryRefresh() async {
    final refresh = _tokens.refreshToken;
    final deviceId = await _tokens.deviceId;
    if (refresh == null || deviceId == null) return false;
    try {
      final body = await this.refresh(refresh, deviceId);
      await _tokens.saveTokens(
        accessToken: body['accessToken'] as String?,
        refreshToken: body['refreshToken'] as String?,
      );
      return _tokens.accessToken != null;
    } on ApiException {
      return false;
    }
  }

  void dispose() => _client.close();
}

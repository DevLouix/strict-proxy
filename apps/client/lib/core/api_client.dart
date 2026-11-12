import 'dart:convert';
import 'package:http/http.dart' as http;

import 'billing_models.dart';
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

  /// Called when a request proves the session cannot be repaired: the access
  /// token was rejected and refreshing it failed too. The auth controller
  /// wires this up so the app leaves the authenticated state instead of showing
  /// a signed-in shell full of failed requests.
  void Function()? onSessionExpired;

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
      // A 401 with no session at all is a failed sign-in, not an expiry, so
      // only an existing token can mean the session is gone.
      if (_tokens.accessToken != null) onSessionExpired?.call();
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

  /// Ends the session server-side.
  ///
  /// Passing the refresh token matters: revoking only the access token would
  /// leave a credential that can mint a new one immediately afterwards. Retries
  /// are off so a logout never races its own automatic refresh.
  Future<void> logout({String? refreshToken}) async {
    await _send(
      () => _client.post(
        _uri('/api/v1/auth/logout'),
        headers: _headers(),
        body: jsonEncode({if (refreshToken != null) 'refreshToken': refreshToken}),
      ),
      retryOn401: false,
    );
  }

  /// Asks the server to start a password reset.
  ///
  /// The server answers the same way whether or not the address exists, so this
  /// cannot be used to discover which emails have accounts. Retries are off: the
  /// endpoint is unauthenticated, so a 401 is not a token expiry.
  Future<Map<String, dynamic>> requestPasswordReset(String email) {
    return _send(
      () => _client.post(
        _uri('/api/v1/auth/password/forgot'),
        headers: _headers(auth: false),
        body: jsonEncode({'email': email}),
      ),
      retryOn401: false,
    );
  }

  /// Completes a password reset with a token from the email or an operator.
  ///
  /// Unauthenticated, so as with the request above a 401 is not a token expiry.
  Future<Map<String, dynamic>> resetPassword(String token, String newPassword) {
    return _send(
      () => _client.post(
        _uri('/api/v1/auth/password/reset'),
        headers: _headers(auth: false),
        body: jsonEncode({'token': token, 'password': newPassword}),
      ),
      retryOn401: false,
    );
  }

  /// Deletes the signed-in account. The password is required by the server so a
  /// stolen access token alone cannot destroy the account.
  ///
  /// Retries are left on here, unlike the password-reset calls: a 401 from this
  /// endpoint is ambiguous — an expired access token, or a wrong password — and
  /// the refresh-then-retry path resolves the first while still surfacing the
  /// second as `INVALID_CREDENTIALS`.
  Future<Map<String, dynamic>> deleteAccount(String password) {
    return _send(() => _client.delete(
          _uri('/api/v1/me'),
          headers: _headers(),
          body: jsonEncode({'password': password}),
        ));
  }

  /// Signed dynamic sing-box config bundle (per-node VLESS+REALITY).
  Future<Map<String, dynamic>> networkConfig() =>
      _send(() => _client.get(_uri('/api/v1/network/config'), headers: _headers()));

  /// Purchasable tiers and their prices.
  Future<BillingCatalog> billingCatalog() async {
    final body = await _send(() => _client.get(_uri('/api/v1/billing/catalog'), headers: _headers()));
    return BillingCatalog.fromJson(body);
  }

  /// Current subscription, limits and rolling-window bandwidth usage.
  Future<SubscriptionSummary> subscription() async {
    final body = await _send(() => _client.get(_uri('/api/v1/billing/subscription'), headers: _headers()));
    return SubscriptionSummary.fromJson(body);
  }

  /// Opens a hosted checkout for [tier] and returns the payment session.
  Future<CheckoutSession> createCheckout(String tier, {String? successUrl, String? cancelUrl, String? couponCode}) async {
    final body = await _send(() => _client.post(
          _uri('/api/v1/billing/checkout'),
          headers: _headers(),
          body: jsonEncode({
            'tier': tier,
            if (successUrl != null) 'successUrl': successUrl,
            if (cancelUrl != null) 'cancelUrl': cancelUrl,
            if (couponCode != null && couponCode.isNotEmpty) 'couponCode': couponCode,
          }),
        ));
    return CheckoutSession.fromJson(body);
  }

  /// Prices a discount code for every purchasable plan before paying.
  Future<CouponPreview> previewCoupon(String code) async {
    final body = await _send(() => _client.post(
          _uri('/api/v1/billing/coupon/preview'),
          headers: _headers(),
          body: jsonEncode({'code': code}),
        ));
    return CouponPreview.fromJson(body);
  }

  /// Starts the monthly subscription from the card saved at checkout.
  ///
  /// Returns null when auto-renew is active, or a human-readable reason when
  /// the account cannot be made recurring (for example, no saved card).
  Future<String?> activateRecurring() async {
    final body = await _send(() => _client.post(
          _uri('/api/v1/billing/recurring/activate'),
          headers: _headers(),
          body: '{}',
        ));
    if (body['activated'] == true) return null;
    return body['message'] as String? ?? body['error'] as String? ?? 'Auto-renew could not be enabled.';
  }

  /// Per-node bandwidth consumption for the signed-in user.
  Future<UsageReport> usage() async {
    final body = await _send(() => _client.get(_uri('/api/v1/billing/usage'), headers: _headers()));
    return UsageReport.fromJson(body);
  }

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

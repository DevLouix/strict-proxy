import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api_client.dart';
import '../../../core/storage/token_store.dart';

enum AuthStatus { unknown, unauthenticated, authenticated }

class AuthState {
  const AuthState({this.status = AuthStatus.unknown, this.email, this.tier});

  final AuthStatus status;
  final String? email;
  final String? tier;

  AuthState copyWith({Object? status = _unset, Object? email = _unset, Object? tier = _unset}) =>
      AuthState(
        status: identical(status, _unset) ? this.status : status as AuthStatus,
        email: identical(email, _unset) ? this.email : email as String?,
        tier: identical(tier, _unset) ? this.tier : tier as String?,
      );

  static const _unset = Object();
}

final tokenStoreProvider = Provider<TokenStore>((ref) => TokenStore());

final apiProvider = Provider<ControllerApi>((ref) {
  final api = ControllerApi(tokens: ref.watch(tokenStoreProvider));
  ref.onDispose(api.dispose);
  return api;
});

final authStateProvider =
    StateNotifierProvider<AuthController, AuthState>((ref) => AuthController(ref));

class AuthController extends StateNotifier<AuthState> {
  AuthController(this._ref) : super(const AuthState()) {
    _restore();
  }

  final Ref _ref;

  Future<void> _restore() async {
    final store = _ref.read(tokenStoreProvider);
    await store.load();
    if (store.accessToken == null) {
      state = state.copyWith(status: AuthStatus.unauthenticated);
      return;
    }
    try {
      final me = await _ref.read(apiProvider).me();
      final user = me['user'] as Map<String, dynamic>;
      state = AuthState(
        status: AuthStatus.authenticated,
        email: user['email'] as String?,
        tier: user['tier'] as String?,
      );
    } on ApiException {
      final refreshed = await _ref.read(apiProvider).tryRefresh();
      if (refreshed) {
        await _restore();
        return;
      }
      await store.clear();
      state = state.copyWith(status: AuthStatus.unauthenticated);
    } catch (_) {
      // A malformed or unexpected /me response must sign the user out rather
      // than leave a broken authenticated state that crashes the home screen.
      await store.clear();
      state = state.copyWith(status: AuthStatus.unauthenticated);
    }
  }

  Future<String?> login(String email, String password) async {
    final store = _ref.read(tokenStoreProvider);
    final deviceId = await store.ensureDeviceIdentity(deviceName: 'StrictProxy Device');
    try {
      final body = await _ref.read(apiProvider).login(email, password, deviceId, 'StrictProxy Device');
      await store.saveTokens(
        accessToken: body['accessToken'] as String?,
        refreshToken: body['refreshToken'] as String?,
      );
      final user = body['user'] as Map<String, dynamic>;
      state = AuthState(
        status: AuthStatus.authenticated,
        email: user['email'] as String?,
        tier: user['tier'] as String?,
      );
      return null;
    } on ApiException catch (e) {
      return e.message;
    }
  }

  Future<String?> register(String email, String password) async {
    try {
      await _ref.read(apiProvider).register(email, password);
      return await login(email, password);
    } on ApiException catch (e) {
      return e.message;
    }
  }

  Future<void> logout() async {
    final store = _ref.read(tokenStoreProvider);
    // Tell the server before dropping the tokens: clearing them locally alone
    // leaves both the access token (until it expires) and the refresh token
    // (for its whole lifetime) usable by anyone who has a copy.
    try {
      await _ref.read(apiProvider).logout(refreshToken: store.refreshToken);
    } on ApiException {
      // Best effort. The user must end up logged out locally even when the
      // controller is unreachable or the token has already expired.
    }
    await store.clear();
    state = state.copyWith(status: AuthStatus.unauthenticated, email: null, tier: null);
  }

  /// Deletes the account server-side, then clears local credentials.
  ///
  /// Returns an error message to show, or null on success. Local state is only
  /// cleared once the server confirms: clearing first would leave the account
  /// intact while the app pretended it was gone.
  Future<String?> deleteAccount(String password) async {
    try {
      await _ref.read(apiProvider).deleteAccount(password);
    } on ApiException catch (e) {
      return e.message;
    }
    await _ref.read(tokenStoreProvider).clear();
    state = state.copyWith(status: AuthStatus.unauthenticated, email: null, tier: null);
    return null;
  }

  /// Asks the server to email a reset link. Returns an error message, or null.
  ///
  /// A null result means "the request was accepted", not "the address exists" —
  /// the server answers identically either way on purpose.
  Future<String?> requestPasswordReset(String email) async {
    try {
      await _ref.read(apiProvider).requestPasswordReset(email);
      return null;
    } on ApiException catch (e) {
      return e.message;
    }
  }

  /// Sets a new password from a reset token. Returns an error message, or null.
  ///
  /// The server signs out every session on success, so the caller should send
  /// the user back to sign in rather than assuming a session was created.
  Future<String?> resetPassword(String token, String newPassword) async {
    try {
      await _ref.read(apiProvider).resetPassword(token, newPassword);
      return null;
    } on ApiException catch (e) {
      return e.message;
    }
  }
}

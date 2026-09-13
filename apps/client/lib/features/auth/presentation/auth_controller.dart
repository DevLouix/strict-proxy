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
    await store.clear();
    state = state.copyWith(status: AuthStatus.unauthenticated, email: null, tier: null);
  }
}

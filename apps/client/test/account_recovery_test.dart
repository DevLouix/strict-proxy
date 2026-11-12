// Account recovery and self-service deletion.
//
// Both are client-side gaps that the server already supported, so these tests
// pin the contract the app owes the server: the reset call carries what the
// user typed (including a token pulled out of a pasted link), and deletion is
// an authenticated, password-confirmed call that only ends the local session
// once the server has agreed.
import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/core/api_client.dart';
import 'package:strict_proxy_client/core/billing_models.dart';
import 'package:strict_proxy_client/core/storage/token_store.dart';
import 'package:strict_proxy_client/features/auth/presentation/auth_controller.dart';
import 'package:strict_proxy_client/features/auth/presentation/password_reset_screen.dart';
import 'package:strict_proxy_client/features/billing/presentation/account_screen.dart';

/// Records the calls under test instead of reaching the network.
class _RecordingApi extends ControllerApi {
  _RecordingApi({this.summary, this.catalog});

  final SubscriptionSummary? summary;
  final BillingCatalog? catalog;

  String? forgotEmail;
  String? sentResetToken;
  String? sentResetPassword;
  String? deletePassword;
  ApiException? fail;

  @override
  Future<Map<String, dynamic>> requestPasswordReset(String email) async {
    forgotEmail = email;
    final err = fail;
    if (err != null) throw err;
    return {'accepted': true};
  }

  @override
  Future<Map<String, dynamic>> resetPassword(String token, String newPassword) async {
    sentResetToken = token;
    sentResetPassword = newPassword;
    final err = fail;
    if (err != null) throw err;
    return {'ok': true};
  }

  @override
  Future<Map<String, dynamic>> deleteAccount(String password) async {
    deletePassword = password;
    final err = fail;
    if (err != null) throw err;
    return {'ok': true};
  }

  @override
  Future<SubscriptionSummary> subscription() async {
    final s = summary;
    if (s == null) throw ApiException(0, 'NETWORK_ERROR', 'no subscription');
    return s;
  }

  @override
  Future<BillingCatalog> billingCatalog() async {
    final c = catalog;
    if (c == null) throw ApiException(503, 'BILLING_NOT_CONFIGURED', 'no gateway');
    return c;
  }

  @override
  Future<String?> activateRecurring() async => null;

  @override
  void dispose() {}
}

/// A TokenStore that never touches secure storage, and notes when it is cleared.
class _FakeTokenStore extends TokenStore {
  bool cleared = false;

  @override
  Future<void> load() async {}

  @override
  Future<void> clear() async {
    cleared = true;
    accessToken = null;
    refreshToken = null;
  }
}

SubscriptionSummary _summary() => SubscriptionSummary(
      tier: 'free',
      status: 'active',
      currentPeriodEnd: DateTime.utc(2026, 12, 1),
      deviceSeats: 1,
      maxNodes: 2,
      bandwidthQuotaBytes: 10737418240,
      bytesUsed: 0,
      bytesRemaining: 5368709120,
      pendingCheckout: null,
    );

const _catalog = BillingCatalog(gateway: 'openpay', currency: 'USD', tiers: []);

List<Override> _overrides(_RecordingApi api, [_FakeTokenStore? store]) => [
      apiProvider.overrideWithValue(api),
      tokenStoreProvider.overrideWithValue(store ?? _FakeTokenStore()),
    ];

/// The reset screen behind a pushable route, so popping back works.
Widget _wrapReset(_RecordingApi api) => ProviderScope(
      overrides: _overrides(api),
      child: MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(builder: (_) => const PasswordResetScreen()),
                ),
                child: const Text('open reset'),
              ),
            ),
          ),
        ),
      ),
    );

Widget _wrapAccount(_RecordingApi api, _FakeTokenStore store) => ProviderScope(
      overrides: _overrides(api, store),
      child: const MaterialApp(home: AccountScreen()),
    );

Future<void> _openResetScreen(WidgetTester tester, _RecordingApi api) async {
  _setTallSurface(tester);
  await tester.pumpWidget(_wrapReset(api));
  await tester.tap(find.text('open reset'));
  await tester.pumpAndSettle();
}

/// The screens are long; the default 800x600 test window leaves the lower
/// fields and buttons unbuilt, so a tap would land on nothing.
void _setTallSurface(WidgetTester tester) {
  tester.view.physicalSize = const Size(1200, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  testWidgets('the reset screen asks the controller to email a link', (tester) async {
    final api = _RecordingApi();
    await _openResetScreen(tester, api);

    await tester.enterText(find.byType(TextFormField).first, 'user@example.com');
    await tester.tap(find.text('Email me a reset link'));
    await tester.pumpAndSettle();

    expect(api.forgotEmail, 'user@example.com');
    expect(find.textContaining('If that account exists'), findsOneWidget);
  });

  testWidgets('a pasted reset link has its token extracted and decoded', (tester) async {
    final api = _RecordingApi();
    await _openResetScreen(tester, api);

    // The email link names the token as a query parameter; the app must not
    // send the whole link as if it were the token.
    await tester.enterText(
      find.byType(TextFormField).at(1),
      'https://app.example.com/reset-password?token=abc%2F123',
    );
    await tester.enterText(find.byType(TextFormField).at(2), 'a-new-password');
    await tester.enterText(find.byType(TextFormField).at(3), 'a-new-password');
    await tester.tap(find.text('Set new password'));
    await tester.pumpAndSettle();

    expect(api.sentResetToken, 'abc/123', reason: 'the token is pulled out and URL-decoded');
    expect(api.sentResetPassword, 'a-new-password');
  });

  testWidgets('a bare reset code is sent as-is', (tester) async {
    final api = _RecordingApi();
    await _openResetScreen(tester, api);

    await tester.enterText(find.byType(TextFormField).at(1), 'relayed-code-42');
    await tester.enterText(find.byType(TextFormField).at(2), 'a-new-password');
    await tester.enterText(find.byType(TextFormField).at(3), 'a-new-password');
    await tester.tap(find.text('Set new password'));
    await tester.pumpAndSettle();

    expect(api.sentResetToken, 'relayed-code-42');
  });

  testWidgets('mismatched passwords never reach the server', (tester) async {
    final api = _RecordingApi();
    await _openResetScreen(tester, api);

    await tester.enterText(find.byType(TextFormField).at(1), 'relayed-code-42');
    await tester.enterText(find.byType(TextFormField).at(2), 'a-new-password');
    await tester.enterText(find.byType(TextFormField).at(3), 'a-different-one');
    await tester.tap(find.text('Set new password'));
    await tester.pumpAndSettle();

    expect(api.sentResetToken, isNull, reason: 'the form validator stops this');
    expect(find.text('Passwords do not match'), findsOneWidget);
  });

  test('deleteAccount clears the local session only after the server agrees', () async {
    final api = _RecordingApi();
    final store = _FakeTokenStore();
    final container = ProviderContainer(overrides: _overrides(api, store));
    addTearDown(container.dispose);
    // Constructing the notifier runs the restore path; the fake store reports
    // no token, so it settles as unauthenticated without any network call.
    await container.read(authStateProvider.notifier).deleteAccount('secret');

    expect(api.deletePassword, 'secret');
    expect(store.cleared, isTrue);
    expect(container.read(authStateProvider).status, AuthStatus.unauthenticated);
  });

  test('a failed deletion keeps the session and surfaces the reason', () async {
    final api = _RecordingApi()..fail = ApiException(401, 'INVALID_CREDENTIALS', 'password is incorrect');
    final store = _FakeTokenStore();
    final container = ProviderContainer(overrides: _overrides(api, store));
    addTearDown(container.dispose);

    final message = await container.read(authStateProvider.notifier).deleteAccount('wrong');

    expect(message, 'password is incorrect');
    expect(store.cleared, isFalse, reason: 'a rejected deletion must not sign the user out locally');
  });

  testWidgets('the account screen deletes only after a password is confirmed', (tester) async {
    _setTallSurface(tester);
    final api = _RecordingApi(summary: _summary(), catalog: _catalog);
    final store = _FakeTokenStore();
    await tester.pumpWidget(_wrapAccount(api, store));
    await tester.pumpAndSettle();

    // The danger-zone button, not the dialog's or the card's label.
    await tester.tap(find.widgetWithText(OutlinedButton, 'Delete account'));
    await tester.pumpAndSettle();
    expect(find.text('Delete account?'), findsOneWidget, reason: 'deletion is confirmed first');

    await tester.enterText(find.byType(TextField), 'secret');
    await tester.tap(find.widgetWithText(FilledButton, 'Delete account'));
    await tester.pumpAndSettle();

    expect(api.deletePassword, 'secret');
    expect(store.cleared, isTrue);
  });
}

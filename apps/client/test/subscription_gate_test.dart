// The entitlement gate is the only thing between a signed-in account and the
// server list, so these tests pin the three cases that matter: a free account is
// paywalled, an active paid account reaches the app, and a lapsed paid plan does
// not fall through.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/core/api_client.dart';
import 'package:strict_proxy_client/core/billing_models.dart';
import 'package:strict_proxy_client/core/storage/token_store.dart';
import 'package:strict_proxy_client/features/auth/presentation/auth_controller.dart';
import 'package:strict_proxy_client/features/billing/presentation/subscription_gate.dart';

class _FakeApi extends ControllerApi {
  _FakeApi(this.summary);

  final SubscriptionSummary summary;

  @override
  Future<Map<String, dynamic>> me() async => {
        'user': {'email': 'user@example.test', 'tier': summary.tier},
        'devices': <dynamic>[],
      };

  @override
  Future<SubscriptionSummary> subscription() async => summary;

  @override
  Future<UsageReport> usage() async => const UsageReport(totalBytes: 0, credentials: []);

  @override
  Future<BillingCatalog> billingCatalog() async => const BillingCatalog(
        gateway: 'openpay',
        currency: 'NGN',
        tiers: [
          TierPrice(tier: 'standard', label: 'Standard', amountMinor: 250000, currency: 'NGN'),
          TierPrice(tier: 'pro', label: 'Pro', amountMinor: 750000, currency: 'NGN'),
        ],
      );

  @override
  void dispose() {}
}

/// Reports a stored session so AuthController restores it as authenticated.
class _SignedInTokenStore extends TokenStore {
  @override
  Future<void> load() async {
    accessToken = 'test-access-token';
  }

  @override
  Future<void> clear() async {
    accessToken = null;
    refreshToken = null;
  }
}

SubscriptionSummary _summary({String tier = 'free', String status = 'active'}) => SubscriptionSummary(
      tier: tier,
      status: status,
      currentPeriodEnd: DateTime.utc(2026, 12, 1),
      deviceSeats: 1,
      maxNodes: 2,
      bandwidthQuotaBytes: 10737418240,
      bytesUsed: 0,
      bytesRemaining: 5368709120,
      pendingCheckout: null,
    );

Widget _gated(_FakeApi api) => ProviderScope(
      overrides: [
        apiProvider.overrideWithValue(api),
        tokenStoreProvider.overrideWithValue(_SignedInTokenStore()),
      ],
      child: const MaterialApp(home: SubscriptionGate(child: Text('APP'))),
    );

void main() {
  testWidgets('a free account sees the paywall instead of the app', (tester) async {
    await tester.pumpWidget(_gated(_FakeApi(_summary(tier: 'free'))));
    await tester.pumpAndSettle();

    expect(find.text('Subscription required'), findsOneWidget);
    expect(find.text('APP'), findsNothing);
    expect(find.text('Standard'), findsOneWidget);
  });

  testWidgets('an active paid account reaches the app', (tester) async {
    await tester.pumpWidget(_gated(_FakeApi(_summary(tier: 'standard'))));
    await tester.pumpAndSettle();

    expect(find.text('APP'), findsOneWidget);
    expect(find.text('Subscription required'), findsNothing);
  });

  testWidgets('a lapsed paid plan is sent back to the paywall', (tester) async {
    await tester.pumpWidget(_gated(_FakeApi(_summary(tier: 'pro', status: 'expired'))));
    await tester.pumpAndSettle();

    expect(find.text('APP'), findsNothing);
    expect(find.text('Subscription required'), findsOneWidget);
  });
}

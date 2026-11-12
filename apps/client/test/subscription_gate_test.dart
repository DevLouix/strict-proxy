// The entitlement gate is the only thing between a signed-in account and the
// server list, so these tests pin the cases that matter: registration is not a
// trial, an active paid account reaches the app, and a lapsed plan does not
// fall through.
import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/core/billing_models.dart';
import 'package:strict_proxy_client/features/billing/application/billing_controller.dart';
import 'package:strict_proxy_client/features/billing/presentation/subscription_gate.dart';

/// A controller with the state already loaded, so the gate can be exercised
/// without a network, a session, or secure storage.
class _FixedBilling extends BillingController {
  final SubscriptionSummary summary;

  _FixedBilling(super.ref, this.summary) {
    state = BillingState(
      subscription: summary,
      catalog: const BillingCatalog(
        gateway: 'openpay',
        currency: 'USD',
        tiers: [
          TierPrice(tier: 'standard', label: 'Standard', amountMinor: 200, currency: 'USD'),
          TierPrice(tier: 'pro', label: 'Pro', amountMinor: 1000, currency: 'USD'),
        ],
      ),
    );
  }

  @override
  void reset() {}

  @override
  Future<void> load() async {}
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

Widget _gated(SubscriptionSummary summary) => ProviderScope(
      overrides: [
        billingProvider.overrideWith((ref) => _FixedBilling(ref, summary)),
      ],
      child: const MaterialApp(home: SubscriptionGate(child: Text('APP'))),
    );

void main() {
  testWidgets('a free account sees the paywall instead of the app', (tester) async {
    await tester.pumpWidget(_gated(_summary(tier: 'free')));
    await tester.pumpAndSettle();

    // The controller's free row carries limits but no access; registration is
    // not a trial, so a new account must buy a plan before reaching the app.
    expect(find.text('Subscription required'), findsOneWidget);
    expect(find.text('APP'), findsNothing);
    expect(find.text('Standard'), findsOneWidget);
  });

  testWidgets('an active paid account reaches the app', (tester) async {
    await tester.pumpWidget(_gated(_summary(tier: 'standard')));
    await tester.pumpAndSettle();

    expect(find.text('APP'), findsOneWidget);
    expect(find.text('Subscription required'), findsNothing);
  });

  testWidgets('an unpaid tier name does not grant access on its own', (tester) async {
    await tester.pumpWidget(_gated(_summary(tier: 'standard', status: 'expired')));
    await tester.pumpAndSettle();

    expect(find.text('APP'), findsNothing);
    expect(find.text('Subscription required'), findsOneWidget);
  });

  testWidgets('a lapsed paid plan is sent back to the paywall', (tester) async {
    await tester.pumpWidget(_gated(_summary(tier: 'pro', status: 'expired')));
    await tester.pumpAndSettle();

    expect(find.text('APP'), findsNothing);
    expect(find.text('Subscription required'), findsOneWidget);
  });

  testWidgets('a revoked free plan is also sent to the paywall', (tester) async {
    await tester.pumpWidget(_gated(_summary(tier: 'free', status: 'revoked')));
    await tester.pumpAndSettle();

    expect(find.text('APP'), findsNothing);
    expect(find.text('Subscription required'), findsOneWidget);
  });
}

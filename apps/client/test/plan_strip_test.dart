import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/core/billing_models.dart';
import 'package:strict_proxy_client/features/home/presentation/plan_strip.dart';

SubscriptionSummary _sub({
  String tier = 'free',
  String status = 'active',
  int? quota = 10737418240,
  int? remaining = 5368709120,
}) =>
    SubscriptionSummary(
      tier: tier,
      status: status,
      currentPeriodEnd: DateTime.utc(2026, 12, 1),
      deviceSeats: 1,
      maxNodes: 2,
      bandwidthQuotaBytes: quota,
      bytesUsed: 0,
      bytesRemaining: remaining,
      pendingCheckout: null,
    );

Widget _wrap(SubscriptionSummary? sub, {VoidCallback? onTap}) => MaterialApp(
      home: Scaffold(body: PlanStrip(subscription: sub, onTap: onTap ?? () {})),
    );

void main() {
  testWidgets('renders nothing until subscription data arrives', (tester) async {
    await tester.pumpWidget(_wrap(null));
    expect(find.byType(PlanStrip), findsOneWidget);
    expect(find.byType(TextButton), findsNothing, reason: 'no empty flash on first paint');
  });

  testWidgets('shows the tier for a capped plan', (tester) async {
    await tester.pumpWidget(_wrap(_sub()));
    expect(find.text('FREE'), findsOneWidget);
    expect(find.text('5.0 GB left'), findsOneWidget);
  });

  testWidgets('shows the tier for an unlimited plan without a quota figure', (tester) async {
    await tester.pumpWidget(_wrap(_sub(tier: 'pro', quota: null, remaining: null)));
    expect(find.text('PRO'), findsOneWidget);
    expect(find.textContaining('left'), findsNothing, reason: 'an unlimited plan has nothing left to report');
  });

  testWidgets('flags an exhausted quota', (tester) async {
    await tester.pumpWidget(_wrap(_sub(remaining: 0)));
    expect(find.text('data used'), findsOneWidget);
    expect(find.textContaining('left'), findsNothing);
  });

  testWidgets('surfaces a non-active subscription status', (tester) async {
    await tester.pumpWidget(_wrap(_sub(status: 'revoked')));
    expect(find.text('FREE'), findsOneWidget);
    expect(find.text('revoked'), findsOneWidget, reason: 'a revoked plan must be visible without opening the account screen');
  });

  testWidgets('is tappable and reports the tap', (tester) async {
    var taps = 0;
    await tester.pumpWidget(_wrap(_sub(), onTap: () => taps++));
    await tester.tap(find.byType(TextButton));
    expect(taps, 1);
  });

  testWidgets('handles every known tier without throwing', (tester) async {
    for (final tier in ['free', 'standard', 'pro']) {
      await tester.pumpWidget(_wrap(_sub(tier: tier)));
      expect(find.text(tier.toUpperCase()), findsOneWidget);
      expect(tester.takeException(), isNull);
    }
  });
}
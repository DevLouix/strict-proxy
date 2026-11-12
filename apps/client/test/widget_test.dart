import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/core/api_client.dart';
import 'package:strict_proxy_client/core/billing_models.dart';
import 'package:strict_proxy_client/features/auth/presentation/auth_controller.dart';
import 'package:strict_proxy_client/features/billing/application/billing_controller.dart';
import 'package:strict_proxy_client/features/billing/presentation/account_screen.dart';
import 'package:strict_proxy_client/main.dart';

/// Stub API returning canned billing payloads. Only the network methods are
/// overridden, so the screen exercises its real rendering path.
class _FakeApi extends ControllerApi {
  _FakeApi({this.catalog, this.summary, this.usageReport, this.checkoutError});

  final BillingCatalog? catalog;
  final SubscriptionSummary? summary;
  final UsageReport? usageReport;
  final ApiException? checkoutError;

  @override
  Future<BillingCatalog> billingCatalog() async {
    final c = catalog;
    if (c == null) throw ApiException(503, 'BILLING_NOT_CONFIGURED', 'no gateway');
    return c;
  }

  @override
  Future<SubscriptionSummary> subscription() async {
    final s = summary;
    if (s == null) throw ApiException(0, 'NETWORK_ERROR', 'Controller request failed: boom');
    return s;
  }

  @override
  Future<UsageReport> usage() async => usageReport ?? const UsageReport(totalBytes: 0, credentials: []);

  @override
  Future<String?> activateRecurring() async => null;

  @override
  Future<CheckoutSession> createCheckout(String tier, {String? successUrl, String? cancelUrl}) async {
    final err = checkoutError;
    if (err != null) throw err;
    return CheckoutSession(
      reference: 'ref_1',
      checkoutUrl: 'https://pay.example/checkout',
      tier: tier,
      amountMinor: 1000,
      currency: 'USD',
    );
  }

  @override
  void dispose() {}
}

SubscriptionSummary _summary({
  String tier = 'free',
  String status = 'active',
  int? quota = 10737418240,
  int used = 0,
  int? remaining,
}) =>
    SubscriptionSummary(
      tier: tier,
      status: status,
      currentPeriodEnd: DateTime.utc(2026, 12, 1),
      deviceSeats: tier == 'free' ? 1 : 3,
      maxNodes: tier == 'free' ? 2 : 10,
      bandwidthQuotaBytes: quota,
      bytesUsed: used,
      bytesRemaining: remaining,
      pendingCheckout: null,
    );

const _catalog = BillingCatalog(
  gateway: 'openpay',
  currency: 'USD',
  tiers: [
    TierPrice(tier: 'standard', label: 'Standard', amountMinor: 200, currency: 'USD'),
    TierPrice(tier: 'pro', label: 'Pro', amountMinor: 1000, currency: 'USD'),
  ],
);

Widget _wrap(_FakeApi api) => ProviderScope(
      overrides: [apiProvider.overrideWithValue(api)],
      child: const MaterialApp(home: AccountScreen()),
    );

void main() {
  testWidgets('StrictProxy app renders', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: StrictProxyApp()));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(MaterialApp), findsOneWidget);
    expect(find.text('StrictProxy'), findsNothing);
  });

  testWidgets('account screen shows the current plan and limits', (tester) async {
    await tester.pumpWidget(_wrap(_FakeApi(summary: _summary(), catalog: _catalog)));
    await tester.pumpAndSettle();

    expect(find.text('Account'), findsOneWidget);
    expect(find.text('Current plan'), findsOneWidget);
    expect(find.text('FREE'), findsOneWidget);
    expect(find.text('active'), findsOneWidget);
    expect(find.text('Simultaneous devices'), findsOneWidget);
    expect(find.text('Server access'), findsOneWidget);
    expect(find.text('Plans'), findsOneWidget);
    expect(find.text('Standard'), findsOneWidget);
    expect(find.text('Pro'), findsOneWidget);
  });

  testWidgets('account screen shows a usage bar for capped tiers', (tester) async {
    await tester.pumpWidget(_wrap(_FakeApi(
      summary: _summary(used: 5368709120, remaining: 5368709120),
      catalog: const BillingCatalog(gateway: 'openpay', currency: 'USD', tiers: []),
    )));
    await tester.pumpAndSettle();

    expect(find.text('Bandwidth this window'), findsOneWidget);
    expect(find.text('5.0 GB of 10.0 GB used'), findsOneWidget);
    expect(find.byType(LinearProgressIndicator), findsOneWidget);
  });

  testWidgets('account screen warns when the quota is exhausted', (tester) async {
    await tester.pumpWidget(_wrap(_FakeApi(
      summary: _summary(used: 10737418240, remaining: 0),
      catalog: const BillingCatalog(gateway: 'openpay', currency: 'USD', tiers: []),
    )));
    await tester.pumpAndSettle();

    expect(find.text('Quota reached'), findsOneWidget);
    expect(find.textContaining('Upgrade to restore access'), findsOneWidget);
  });

  testWidgets('account screen surfaces an API failure', (tester) async {
    await tester.pumpWidget(_wrap(_FakeApi()));
    await tester.pumpAndSettle();

    expect(find.textContaining('Controller request failed'), findsOneWidget);
  });

  testWidgets('account screen disables upgrades when no gateway is configured', (tester) async {
    await tester.pumpWidget(_wrap(_FakeApi(
      summary: _summary(),
      catalog: const BillingCatalog(gateway: 'unconfigured', currency: 'USD', tiers: []),
    )));
    await tester.pumpAndSettle();

    expect(find.textContaining('no payment gateway configured'), findsOneWidget);
  });

  testWidgets('account screen lists per-node usage', (tester) async {
    await tester.pumpWidget(_wrap(_FakeApi(
      summary: _summary(),
      catalog: const BillingCatalog(gateway: 'openpay', currency: 'USD', tiers: []),
      usageReport: const UsageReport(
        totalBytes: 3000,
        credentials: [
          CredentialUsage(nodeId: 'node-1', bytesUsed: 2048, revoked: false),
          CredentialUsage(nodeId: 'node-2', bytesUsed: 952, revoked: true),
        ],
      ),
    )));
    await tester.pumpAndSettle();

    expect(find.text('Usage by node'), findsOneWidget);
    expect(find.text('node-1'), findsOneWidget);
    expect(find.text('node-2'), findsOneWidget);
  });

  test('the controller exposes subscription state', () async {
    final container = ProviderContainer(
      overrides: [apiProvider.overrideWithValue(_FakeApi(summary: _summary(tier: 'pro', quota: null), catalog: _catalog))],
    );
    addTearDown(container.dispose);

    await container.read(billingProvider.notifier).load();

    final state = container.read(billingProvider);
    expect(state.loading, isFalse);
    expect(state.error, isNull);
    expect(state.subscription?.tier, 'pro');
    expect(state.subscription?.hasQuota, isFalse);
  });

  test('startCheckout surfaces the provider URL and clears afterwards', () async {
    final container = ProviderContainer(
      overrides: [apiProvider.overrideWithValue(_FakeApi(summary: _summary(), catalog: _catalog))],
    );
    addTearDown(container.dispose);

    final controller = container.read(billingProvider.notifier);
    final url = await controller.startCheckout('pro');

    expect(url, 'https://pay.example/checkout');
    expect(container.read(billingProvider).checkout, isNotNull);

    controller.consumeCheckout();
    expect(container.read(billingProvider).checkout, isNull);
  });

  test('startCheckout reports an API error instead of throwing', () async {
    final container = ProviderContainer(
      overrides: [
        apiProvider.overrideWithValue(_FakeApi(checkoutError: ApiException(409, 'TIER_NOT_PURCHASABLE', 'not purchasable'))),
      ],
    );
    addTearDown(container.dispose);

    final url = await container.read(billingProvider.notifier).startCheckout('free');

    expect(url, isNull, reason: 'an error message must never be opened as a URL');
    expect(container.read(billingProvider).error, 'not purchasable');
    expect(container.read(billingProvider).startingCheckout, isFalse);
  });
}
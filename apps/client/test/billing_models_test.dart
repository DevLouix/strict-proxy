import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/core/billing_models.dart';

void main() {
  group('BillingCatalog', () {
    test('parses a normal catalog payload', () {
      final catalog = BillingCatalog.fromJson({
        'gateway': 'openpay',
        'currency': 'USD',
        'tiers': [
          {'tier': 'standard', 'label': 'Standard', 'amountMinor': 200, 'currency': 'USD'},
          {'tier': 'pro', 'label': 'Pro', 'amountMinor': 1000, 'currency': 'USD'},
        ],
      });

      expect(catalog.gateway, 'openpay');
      expect(catalog.isUnconfigured, isFalse);
      expect(catalog.tiers.length, 2);
      expect(catalog.tierNamed('pro')!.amountMinor, 1000);
      expect(catalog.tierNamed('free'), isNull);
    });

    test('parses the controller shape where the price is nested', () {
      // The controller sends {tier, price: {...}}; reading amountMinor from the
      // top level found nothing, so every plan rendered as "USD 0" in the app.
      final catalog = BillingCatalog.fromJson({
        'gateway': 'openpay',
        'currency': 'USD',
        'tiers': [
          {'tier': 'standard', 'price': {'amountMinor': 450, 'currency': 'USD', 'label': 'Standard'}},
        ],
      });

      final standard = catalog.tierNamed('standard')!;
      expect(standard.amountMinor, 450);
      expect(standard.label, 'Standard');
      expect(standard.formatted, 'USD 4.50');
      expect(standard.isPriced, isTrue);
    });

    test('an unpriced tier says so instead of advertising zero', () {
      final catalog = BillingCatalog.fromJson({
        'tiers': [
          {'tier': 'pro', 'label': 'Pro'},
        ],
      });

      expect(catalog.tierNamed('pro')!.isPriced, isFalse);
      expect(catalog.tierNamed('pro')!.formatted, 'Price unavailable');
    });

    test('flags an unconfigured gateway', () {
      final catalog = BillingCatalog.fromJson({'gateway': 'unconfigured', 'currency': 'USD', 'tiers': <dynamic>[]});
      expect(catalog.isUnconfigured, isTrue);
      expect(catalog.tiers, isEmpty);
    });

    test('tolerates a malformed payload instead of throwing', () {
      final catalog = BillingCatalog.fromJson({'tiers': 'not-a-list'});
      expect(catalog.gateway, 'unknown');
      expect(catalog.tiers, isEmpty);
    });

    test('tier price formats minor units as a major amount', () {
      expect(const TierPrice(tier: 'pro', label: 'Pro', amountMinor: 1000, currency: 'USD').formatted, 'USD 10');
      expect(const TierPrice(tier: 'pro', label: 'Pro', amountMinor: 2050, currency: 'USD').formatted, 'USD 20.50');
    });
  });

  group('SubscriptionSummary', () {
    Map<String, dynamic> payload({
      String tier = 'free',
      String status = 'active',
      int? quotaBytes = 10737418240,
      int bytesUsed = 0,
      int? bytesRemaining,
    }) =>
        {
          'tier': tier,
          'status': status,
          'currentPeriodEnd': '2026-12-01T00:00:00Z',
          'limits': {'deviceSeats': 1, 'maxNodes': 2, 'bandwidthQuotaBytes': quotaBytes},
          'usage': {'bytesUsed': bytesUsed, 'bytesRemaining': bytesRemaining},
          'pendingCheckout': {'reference': 'spx-123'},
          'autoRenew': true,
        };

    test('parses limits and usage', () {
      final sub = SubscriptionSummary.fromJson(payload(bytesUsed: 5368709120));
      expect(sub.tier, 'free');
      expect(sub.isActive, isTrue);
      expect(sub.deviceSeats, 1);
      expect(sub.maxNodes, 2);
      expect(sub.hasQuota, isTrue);
      expect(sub.bandwidthQuotaBytes, 10737418240);
      expect(sub.bytesUsed, 5368709120);
      expect(sub.currentPeriodEnd, isNotNull);
      expect(sub.pendingCheckout, 'spx-123');
      expect(sub.autoRenew, isTrue);
    });

    test('an unlimited tier reports no quota', () {
      final sub = SubscriptionSummary.fromJson(payload(tier: 'pro', quotaBytes: null, bytesRemaining: null));
      expect(sub.hasQuota, isFalse);
      expect(sub.bandwidthQuotaBytes, isNull);
      expect(sub.quotaUsedFraction, 0);
    });

    test('quota fraction reflects consumption and clamps at 1', () {
      expect(SubscriptionSummary.fromJson(payload(bytesUsed: 5368709120)).quotaUsedFraction, closeTo(0.5, 0.001));
      // Over-consumption must not produce a fraction above 1.
      expect(SubscriptionSummary.fromJson(payload(bytesUsed: 99999999999)).quotaUsedFraction, 1.0);
    });

    test('reports quota exhaustion when nothing remains', () {
      final sub = SubscriptionSummary.fromJson(payload(bytesUsed: 10737418240, bytesRemaining: 0));
      expect(sub.isQuotaExhausted, isTrue);
    });

    test('a revoked subscription is not active', () {
      final sub = SubscriptionSummary.fromJson(payload(status: 'revoked'));
      expect(sub.isActive, isFalse);
    });

    test('an active free plan grants access without being a paid plan', () {
      // The controller serves free accounts a 10 GiB plan, so the gate must
      // follow "active" rather than "paid"; only auto-renew needs a paid tier.
      final sub = SubscriptionSummary.fromJson(payload(tier: 'free'));
      expect(sub.hasActivePlan, isTrue);
      expect(sub.hasActivePaidPlan, isFalse);
      expect(SubscriptionSummary.fromJson(payload(status: 'expired')).hasActivePlan, isFalse);
    });

    test('survives a completely empty payload', () {
      final sub = SubscriptionSummary.fromJson(const {});
      expect(sub.tier, 'free');
      expect(sub.deviceSeats, 0);
      expect(sub.hasQuota, isFalse);
      expect(sub.currentPeriodEnd, isNull);
      expect(sub.pendingCheckout, isNull);
    });
  });

  group('CheckoutSession', () {
    test('parses the fields the UI needs', () {
      final session = CheckoutSession.fromJson({
        'reference': 'op_ref_1',
        'checkoutUrl': 'https://pay.example/abc',
        'tier': 'pro',
        'amountMinor': 1000,
        'currency': 'USD',
      });
      expect(session.checkoutUrl, 'https://pay.example/abc');
      expect(session.tier, 'pro');
      expect(session.amountMinor, 1000);
    });

    test('defaults an empty payload rather than throwing', () {
      final session = CheckoutSession.fromJson(const {});
      expect(session.checkoutUrl, '');
      expect(session.tier, 'unknown');
    });
  });

  group('UsageReport', () {
    test('parses and preserves credentials', () {
      final report = UsageReport.fromJson({
        'totalBytes': 3000,
        'credentials': [
          {'nodeId': 'n1', 'bytesUsed': 2000, 'revoked': false},
          {'nodeId': 'n2', 'bytesUsed': 1000, 'revoked': true},
        ],
      });
      expect(report.totalBytes, 3000);
      expect(report.credentials.length, 2);
      expect(report.credentials.first.revoked, isFalse);
      expect(report.credentials.last.revoked, isTrue);
    });

    test('tolerates a missing credential list', () {
      final report = UsageReport.fromJson(const {'totalBytes': 10});
      expect(report.credentials, isEmpty);
    });
  });

  group('formatBytes', () {
    test('formats across magnitudes', () {
      expect(formatBytes(0), '0 B');
      expect(formatBytes(512), '512 B');
      expect(formatBytes(1024), '1.0 KB');
      expect(formatBytes(1024 * 1024), '1.0 MB');
      expect(formatBytes(1073741824), '1.0 GB');
      expect(formatBytes(-5), '0 B');
    });
  });

  group('formatDate', () {
    test('renders an em dash for null', () {
      expect(formatDate(null), '—');
    });

    test('pads month and day', () {
      expect(formatDate(DateTime(2026, 1, 2)), '2026-01-02');
    });
  });
}
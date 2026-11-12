/// Typed models for the controller's billing API.
///
/// Parsing is defensive on purpose: a malformed or partial response must
/// render something sensible rather than crash the account screen. Every
/// `fromJson` tolerates missing fields and returns a usable object.
library;

/// A tier that can be purchased, with its price.
class TierPrice {
  const TierPrice({required this.tier, required this.label, required this.amountMinor, required this.currency});

  final String tier;
  final String label;
  final int amountMinor;
  final String currency;

  /// Parses one catalog entry.
  ///
  /// The controller sends `{tier, price: {amountMinor, currency, label}}`, so
  /// reading the amount from the top level found nothing and every plan
  /// advertised "USD 0" — the price the operator set never reached the screen.
  /// The flat shape is still accepted because fixtures and older payloads use it.
  factory TierPrice.fromJson(Map<String, dynamic> json) {
    final nested = json['price'];
    final price = nested is Map<String, dynamic> ? nested : const <String, dynamic>{};
    final source = price.isEmpty ? json : price;
    final tier = json['tier'] as String? ?? 'unknown';
    return TierPrice(
      tier: tier,
      label: source['label'] as String? ?? json['label'] as String? ?? tier,
      amountMinor: _asInt(source['amountMinor']),
      currency: source['currency'] as String? ?? json['currency'] as String? ?? 'USD',
    );
  }

  /// Whether the catalog sent a usable amount for this tier.
  bool get isPriced => amountMinor > 0;

  /// Price as a major-unit string (amounts are minor units, e.g. kobo).
  String get formatted {
    if (!isPriced) return 'Price unavailable';
    final value = amountMinor / 100;
    final digits = value == value.roundToDouble() ? 0 : 2;
    return '$currency ${value.toStringAsFixed(digits)}';
  }
}

/// The purchasable tier catalog.
class BillingCatalog {
  const BillingCatalog({required this.gateway, required this.currency, required this.tiers});

  final String gateway;
  final String currency;
  final List<TierPrice> tiers;

  /// True when the deployment has no live payment gateway configured.
  bool get isUnconfigured => gateway == 'unconfigured';

  factory BillingCatalog.fromJson(Map<String, dynamic> json) {
    final raw = json['tiers'];
    final tiers = raw is List
        ? raw
            .whereType<Map<String, dynamic>>()
            .map(TierPrice.fromJson)
            .toList(growable: false)
        : const <TierPrice>[];
    return BillingCatalog(
      gateway: json['gateway'] as String? ?? 'unknown',
      currency: json['currency'] as String? ?? 'USD',
      tiers: tiers,
    );
  }

  TierPrice? tierNamed(String name) {
    for (final t in tiers) {
      if (t.tier == name) return t;
    }
    return null;
  }
}

/// A hosted checkout opened with the provider.
class CheckoutSession {
  const CheckoutSession({
    required this.reference,
    required this.checkoutUrl,
    required this.tier,
    required this.amountMinor,
    required this.currency,
  });

  final String reference;
  final String checkoutUrl;
  final String tier;
  final int amountMinor;
  final String currency;

  factory CheckoutSession.fromJson(Map<String, dynamic> json) => CheckoutSession(
        reference: json['reference'] as String? ?? '',
        checkoutUrl: json['checkoutUrl'] as String? ?? '',
        tier: json['tier'] as String? ?? 'unknown',
        amountMinor: _asInt(json['amountMinor']),
        currency: json['currency'] as String? ?? 'USD',
      );
}

/// The user's current subscription and rolling-window usage.
class SubscriptionSummary {
  const SubscriptionSummary({
    required this.tier,
    required this.status,
    required this.currentPeriodEnd,
    required this.deviceSeats,
    required this.maxNodes,
    required this.bandwidthQuotaBytes,
    required this.bytesUsed,
    required this.bytesRemaining,
    required this.pendingCheckout,
    this.autoRenew = false,
  });

  final String tier;
  final String status;
  final DateTime? currentPeriodEnd;
  final int deviceSeats;
  final int maxNodes;

  /// null means unlimited.
  final int? bandwidthQuotaBytes;
  final int bytesUsed;

  /// null means unlimited.
  final int? bytesRemaining;
  final String? pendingCheckout;

  /// True once the saved card is attached to a monthly provider subscription.
  final bool autoRenew;

  bool get isActive => status == 'active';

  /// Tiers sold by the catalog. `free` is a real, usable tier, but it is not
  /// something the app can charge for or attach auto-renew to.
  bool get isPaidTier => tier == 'standard' || tier == 'pro';

  /// Status only: a free account still has an active subscription row, but it
  /// grants no tunnel. Access checks must use [hasActivePaidPlan]; this stays
  /// for screens that describe account state rather than entitlement.
  bool get hasActivePlan => isActive;

  /// The paid subset, used where a saved card or a billing period is required
  /// (auto-renew) rather than for ordinary access.
  bool get hasActivePaidPlan => isActive && isPaidTier;

  bool get hasQuota => bandwidthQuotaBytes != null;

  /// 0..1 fraction of the quota consumed; 0 when unlimited.
  double get quotaUsedFraction {
    final quota = bandwidthQuotaBytes;
    if (quota == null || quota <= 0) return 0;
    // `clamp` is declared on `num` and returns `num`, so converting back to
    // double here is required rather than cosmetic.
    return (bytesUsed / quota).clamp(0.0, 1.0).toDouble();
  }

  bool get isQuotaExhausted => bytesRemaining != null && bytesRemaining! <= 0;

  factory SubscriptionSummary.fromJson(Map<String, dynamic> json) {
    final limits = _map(json['limits']);
    final usage = _map(json['usage']);
    final quota = _asNullableInt(limits['bandwidthQuotaBytes']);
    final remaining = _asNullableInt(usage['bytesRemaining']);
    final pending = _map(json['pendingCheckout']);
    return SubscriptionSummary(
      tier: json['tier'] as String? ?? 'free',
      status: json['status'] as String? ?? 'unknown',
      currentPeriodEnd: _asDate(json['currentPeriodEnd']),
      deviceSeats: _asInt(limits['deviceSeats']),
      maxNodes: _asInt(limits['maxNodes']),
      bandwidthQuotaBytes: quota,
      bytesUsed: _asInt(usage['bytesUsed']),
      bytesRemaining: remaining,
      pendingCheckout: pending['reference'] as String?,
      autoRenew: json['autoRenew'] == true,
    );
  }
}

/// Per-node bandwidth consumption.
class UsageReport {
  const UsageReport({required this.totalBytes, required this.credentials});

  final int totalBytes;
  final List<CredentialUsage> credentials;

  factory UsageReport.fromJson(Map<String, dynamic> json) {
    final raw = json['credentials'];
    final rows = raw is List ? raw.whereType<Map<String, dynamic>>().map(CredentialUsage.fromJson).toList(growable: false) : const <CredentialUsage>[];
    return UsageReport(totalBytes: _asInt(json['totalBytes']), credentials: rows);
  }
}

class CredentialUsage {
  const CredentialUsage({required this.nodeId, required this.bytesUsed, required this.revoked});

  final String nodeId;
  final int bytesUsed;
  final bool revoked;

  factory CredentialUsage.fromJson(Map<String, dynamic> json) => CredentialUsage(
        nodeId: json['nodeId'] as String? ?? '',
        bytesUsed: _asInt(json['bytesUsed']),
        revoked: json['revoked'] == true,
      );
}

/// One plan's price after a coupon is applied.
class CouponTierPrice {
  const CouponTierPrice({
    required this.tier,
    required this.label,
    required this.currency,
    required this.amountBeforeMinor,
    required this.discountMinor,
    required this.amountAfterMinor,
  });

  final String tier;
  final String label;
  final String currency;
  final int amountBeforeMinor;
  final int discountMinor;
  final int amountAfterMinor;

  String get formatted {
    final value = amountAfterMinor / 100;
    final digits = value == value.roundToDouble() ? 0 : 2;
    return '$currency ${value.toStringAsFixed(digits)}';
  }

  factory CouponTierPrice.fromJson(Map<String, dynamic> json) => CouponTierPrice(
        tier: json['tier'] as String? ?? '',
        label: json['label'] as String? ?? '',
        currency: json['currency'] as String? ?? 'USD',
        amountBeforeMinor: _asInt(json['amountBeforeMinor']),
        discountMinor: _asInt(json['discountMinor']),
        amountAfterMinor: _asInt(json['amountAfterMinor']),
      );
}

/// A discount code the controller has validated, with its plan prices.
class CouponPreview {
  const CouponPreview({
    required this.code,
    required this.kind,
    required this.percentOff,
    required this.amountOffMinor,
    required this.tiers,
  });

  final String code;
  final String kind;
  final int? percentOff;
  final int? amountOffMinor;
  final List<CouponTierPrice> tiers;

  CouponTierPrice? tierNamed(String name) {
    for (final tier in tiers) {
      if (tier.tier == name) return tier;
    }
    return null;
  }

  factory CouponPreview.fromJson(Map<String, dynamic> json) {
    final raw = json['tiers'];
    final tiers = raw is List
        ? raw.whereType<Map<String, dynamic>>().map(CouponTierPrice.fromJson).toList(growable: false)
        : const <CouponTierPrice>[];
    return CouponPreview(
      code: json['code'] as String? ?? '',
      kind: json['kind'] as String? ?? 'percent',
      percentOff: _asNullableInt(json['percentOff']),
      amountOffMinor: _asNullableInt(json['amountOffMinor']),
      tiers: tiers,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

Map<String, dynamic> _map(Object? value) => value is Map<String, dynamic> ? value : const <String, dynamic>{};

int _asInt(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value) ?? 0;
  return 0;
}

int? _asNullableInt(Object? value) {
  if (value == null) return null;
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value);
  return null;
}

DateTime? _asDate(Object? value) {
  if (value is! String || value.isEmpty) return null;
  return DateTime.tryParse(value);
}

/// Human-readable byte size.
String formatBytes(int bytes) {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var value = bytes.toDouble();
  var unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  final digits = value >= 100 || unit == 0 ? 0 : 1;
  return '${value.toStringAsFixed(digits)} ${units[unit]}';
}

/// Human-readable date; null renders as an em dash.
String formatDate(DateTime? value) => value == null ? '—' : '${value.year}-${_two(value.month)}-${_two(value.day)}';

String _two(int n) => n.toString().padLeft(2, '0');
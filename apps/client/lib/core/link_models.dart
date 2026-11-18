/// Models for the controller's gated links feed.
///
/// A link is a site an operator has put behind the Gatekeeper. The controller
/// decides which plan may open it, so the app never has to guess: locked items
/// arrive without a usable URL, and [LinksCatalog.upgradeMessage] explains how
/// many more links a higher plan makes visible.
library;

/// One operator-published, tier-gated link.
class GatedLink {
  const GatedLink({
    required this.id,
    required this.title,
    required this.url,
    required this.requiredTier,
    required this.locked,
    this.description,
    this.accessUrl,
  });

  final String id;
  final String title;
  final String url;

  /// Minimum plan the site accepts: `standard` or `pro`.
  final String requiredTier;

  /// True when the signed-in account's plan does not reach [requiredTier].
  final bool locked;

  final String? description;

  /// URL with a short-lived gate ticket appended. Only present when unlocked.
  final String? accessUrl;

  factory GatedLink.fromJson(Map<String, dynamic> json) => GatedLink(
        id: json['id'] as String,
        title: json['title'] as String,
        url: json['url'] as String,
        requiredTier: json['requiredTier'] as String? ?? 'standard',
        locked: json['locked'] as bool? ?? true,
        description: json['description'] as String?,
        accessUrl: json['accessUrl'] as String?,
      );

  /// The plan name a person would recognise.
  String get tierLabel => tierLabelFor(requiredTier);
}

/// Human label for a tier slug.
String tierLabelFor(String tier) => switch (tier) {
      'pro' => 'Pro',
      'standard' => 'Standard',
      _ => 'Free',
    };

/// The links feed plus what the account can and cannot open.
class LinksCatalog {
  const LinksCatalog({
    required this.tier,
    required this.links,
    required this.total,
    required this.accessible,
    required this.locked,
    this.upgradeTier,
    this.upgradeMessage,
  });

  final String tier;
  final List<GatedLink> links;
  final int total;
  final int accessible;
  final int locked;

  /// Cheapest plan that would reveal at least one more link.
  final String? upgradeTier;

  /// Pre-computed sentence: "You can see 2 of 5 links. Standard unlocks 3 more."
  final String? upgradeMessage;

  bool get hasLocked => locked > 0;
  bool get isEmpty => links.isEmpty;

  factory LinksCatalog.fromJson(Map<String, dynamic> json) {
    final items = (json['links'] as List<dynamic>? ?? const [])
        .map((e) => GatedLink.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
    final counts = json['counts'] as Map<String, dynamic>? ?? const {};
    final upgrade = json['upgrade'] as Map<String, dynamic>?;
    return LinksCatalog(
      tier: json['tier'] as String? ?? 'free',
      links: items,
      total: (counts['total'] as num?)?.toInt() ?? items.length,
      accessible: (counts['accessible'] as num?)?.toInt() ??
          items.where((link) => !link.locked).length,
      locked: (counts['locked'] as num?)?.toInt() ??
          items.where((link) => link.locked).length,
      upgradeTier: upgrade?['tier'] as String?,
      upgradeMessage: upgrade?['message'] as String?,
    );
  }
}

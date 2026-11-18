import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/core/link_models.dart';

/// The links feed is the only place a customer learns that a higher plan
/// reveals more sites, so its parsing and labels are pinned directly.
void main() {
  Map<String, dynamic> payload() => {
        'tier': 'standard',
        'links': [
          {
            'id': 'l1',
            'title': 'Standard desk',
            'url': 'https://standard.example.com',
            'description': 'Reports',
            'requiredTier': 'standard',
            'locked': false,
            'accessUrl': 'https://standard.example.com?sp_ticket=abc',
          },
          {
            'id': 'l2',
            'title': 'Pro terminal',
            'url': 'https://pro.example.com',
            'requiredTier': 'pro',
            'locked': true,
            'accessUrl': null,
          },
        ],
        'counts': {'total': 2, 'accessible': 1, 'locked': 1},
        'upgrade': {
          'tier': 'pro',
          'lockedCount': 1,
          'message': 'You can see 1 of 2 links. Pro unlocks 1 more.',
        },
      };

  test('parses the feed, the counts and the upgrade hint', () {
    final catalog = LinksCatalog.fromJson(payload());

    expect(catalog.tier, 'standard');
    expect(catalog.links, hasLength(2));
    expect(catalog.total, 2);
    expect(catalog.accessible, 1);
    expect(catalog.locked, 1);
    expect(catalog.hasLocked, isTrue);
    expect(catalog.upgradeTier, 'pro');
    expect(catalog.upgradeMessage, 'You can see 1 of 2 links. Pro unlocks 1 more.');
  });

  test('a locked link never carries an access URL', () {
    final catalog = LinksCatalog.fromJson(payload());
    final locked = catalog.links.firstWhere((link) => link.locked);

    expect(locked.accessUrl, isNull);
    expect(locked.tierLabel, 'Pro');
    expect(locked.description, isNull);
  });

  test('tier labels match the plan names users see', () {
    expect(tierLabelFor('standard'), 'Standard');
    expect(tierLabelFor('pro'), 'Pro');
    expect(tierLabelFor('free'), 'Free');
  });

  test('counts fall back to the link list when the server omits them', () {
    final catalog = LinksCatalog.fromJson({
      'tier': 'free',
      'links': [
        {'id': 'a', 'title': 'A', 'url': 'https://a.example.com', 'requiredTier': 'pro', 'locked': true},
      ],
    });

    expect(catalog.total, 1);
    expect(catalog.accessible, 0);
    expect(catalog.locked, 1);
    expect(
      catalog.upgradeMessage,
      isNull,
      reason: 'no message means the UI builds no upsell',
    );
  });
}

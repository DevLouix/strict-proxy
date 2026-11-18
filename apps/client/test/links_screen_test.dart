import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/core/api_client.dart';
import 'package:strict_proxy_client/core/link_models.dart';
import 'package:strict_proxy_client/features/auth/presentation/auth_controller.dart';
import 'package:strict_proxy_client/features/links/presentation/links_screen.dart';

/// A links screen test only needs the feed: nothing else is fetched.
class _FakeApi implements ControllerApi {
  _FakeApi(this.catalog);

  final LinksCatalog catalog;

  @override
  Future<LinksCatalog> links() async => catalog;

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName} is not used by this screen');
}

LinksCatalog _catalog({String tier = 'free'}) => LinksCatalog(
      tier: tier,
      total: 2,
      accessible: tier == 'free' ? 0 : 1,
      locked: tier == 'free' ? 2 : 1,
      upgradeTier: tier == 'free' ? 'standard' : 'pro',
      upgradeMessage: tier == 'free'
          ? 'Standard unlocks 2 links.'
          : 'You can see 1 of 2 links. Pro unlocks 1 more.',
      links: [
        GatedLink(
          id: 'l1',
          title: 'Standard desk',
          url: 'https://standard.example.com',
          requiredTier: 'standard',
          locked: tier == 'free',
          accessUrl: tier == 'free' ? null : 'https://standard.example.com?sp_ticket=abc',
        ),
        const GatedLink(
          id: 'l2',
          title: 'Pro terminal',
          url: 'https://pro.example.com',
          requiredTier: 'pro',
          locked: true,
        ),
      ],
    );

Widget _wrap(LinksCatalog catalog) => ProviderScope(
      overrides: [apiProvider.overrideWithValue(_FakeApi(catalog))],
      child: const MaterialApp(home: LinksScreen()),
    );

void main() {
  testWidgets('a free account sees locked links and the plan that unlocks them',
      (tester) async {
    await tester.pumpWidget(_wrap(_catalog()));
    await tester.pumpAndSettle();

    expect(find.text('Links'), findsOneWidget);
    expect(find.text('More links on Standard'), findsOneWidget);
    expect(find.text('Standard unlocks 2 links.'), findsOneWidget);
    expect(find.text('Requires the Standard plan'), findsOneWidget);
    expect(find.text('Requires the Pro plan'), findsOneWidget);
    expect(find.text('Open'), findsNothing, reason: 'nothing is openable on a free plan');
  });

  testWidgets('a standard account opens standard links and sees the Pro upsell',
      (tester) async {
    await tester.pumpWidget(_wrap(_catalog(tier: 'standard')));
    await tester.pumpAndSettle();

    expect(find.text('More links on Pro'), findsOneWidget);
    expect(find.text('Upgrade to Pro'), findsOneWidget);
    expect(find.text('Open'), findsOneWidget, reason: 'only the unlocked link is openable');
    expect(find.text('Requires the Pro plan'), findsOneWidget);
  });
}

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/core/api_client.dart';
import 'package:strict_proxy_client/features/engine/bundle_verifier.dart';
import 'package:strict_proxy_client/features/engine/config_bundle_loader.dart';
import 'package:strict_proxy_client/features/engine/engine_adapter.dart';

/// A loader test needs a stand-in for the controller. Only `networkConfig` is
/// used, so a minimal fake is enough and keeps the test honest about which
/// surface actually matters.
class _FakeApi implements ControllerApi {
  _FakeApi(this._bundle);

  final Map<String, dynamic> _bundle;
  int calls = 0;

  @override
  Future<Map<String, dynamic>> networkConfig() async {
    calls++;
    return _bundle;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName} is not used by the loader');
}

void main() {
  late String publicKeyBase64;
  late List<dynamic> fixtures;
  late Map<String, dynamic> wireBundle;

  setUpAll(() {
    final raw = jsonDecode(File('test/canonical_fixtures.json').readAsStringSync()) as Map<String, dynamic>;
    publicKeyBase64 = raw['publicKeyBase64'] as String;
    fixtures = raw['fixtures'] as List<dynamic>;
    wireBundle = raw['wireBundle'] as Map<String, dynamic>;
  });

  BundleVerifier trusted() => BundleVerifier(publicKeyBytes: base64Decode(publicKeyBase64));
  BundleVerifier untrusted() => BundleVerifier(publicKeyBytes: List<int>.filled(32, 3));

  Map<String, dynamic> withFields(Map<String, dynamic> overrides) => {
        ...wireBundle,
        ...overrides,
      };

  test('accepts a genuine bundle signed by the controller', () async {
    final loader = ConfigBundleLoader(api: _FakeApi(wireBundle), verifier: trusted());
    final bundle = await loader.load();
    expect(bundle.nodes, hasLength(1));
    expect(bundle.signature, isNotEmpty);
    expect(bundle.keyId, 'kid-fixture');
    expect(bundle.rawConfigs, isNotEmpty);
  });

  test('refuses a bundle whose node was pointed at an attacker', () async {
    final hijacked = Map<String, dynamic>.from(wireBundle['nodes'][0] as Map<String, dynamic>);
    hijacked['publicIp'] = '203.0.113.99';
    hijacked['tunnelHost'] = 'attacker.example';
    final loader = ConfigBundleLoader(
      api: _FakeApi(withFields({'nodes': [hijacked]})),
      verifier: trusted(),
    );
    await expectLater(loader.load(), throwsA(isA<BundleVerificationException>()));
  });

  test('refuses a bundle whose credential config was swapped', () async {
    final loader = ConfigBundleLoader(
      api: _FakeApi(withFields({'configs': <String, dynamic>{}})),
      verifier: trusted(),
    );
    await expectLater(loader.load(), throwsA(isA<BundleVerificationException>()));
  });

  test('refuses a bundle signed by an untrusted key', () async {
    final loader = ConfigBundleLoader(api: _FakeApi(wireBundle), verifier: untrusted());
    await expectLater(loader.load(), throwsA(isA<BundleVerificationException>()));
  });

  test('refuses an expired bundle, with a message that says so', () async {
    final loader = ConfigBundleLoader(
      api: _FakeApi(withFields({'expiresAt': '2020-01-01T00:00:00.000Z'})),
      verifier: trusted(),
    );
    await expectLater(
      loader.load(),
      throwsA(isA<BundleVerificationException>().having((e) => e.reason, 'reason', contains('expired'))),
    );
  });

  test('refuses a truncated or garbage signature', () async {
    for (final bad in ['', 'AAAA', 'not base64!!']) {
      final loader = ConfigBundleLoader(
        api: _FakeApi(withFields({'signature': bad})),
        verifier: trusted(),
      );
      await expectLater(loader.load(), throwsA(isA<BundleVerificationException>()), reason: 'signature: "$bad"');
    }
  });

  test('fails closed when a signature is required but no key is configured', () async {
    final loader = ConfigBundleLoader(api: _FakeApi(wireBundle), verifier: null, requireSignature: true);
    await expectLater(
      loader.load(),
      throwsA(isA<BundleVerificationException>().having((e) => e.reason, 'reason', contains('cannot verify'))),
    );
  });

  test('tolerates an unverified bundle when verification is not required', () async {
    // The development posture: no key configured, verification not required.
    final loader = ConfigBundleLoader(
      api: _FakeApi(withFields({'signature': 'AAAA'})),
      verifier: null,
      requireSignature: false,
    );
    expect((await loader.load()).nodes, hasLength(1));
  });

  test('fetches exactly once per load', () async {
    final api = _FakeApi(wireBundle);
    await ConfigBundleLoader(api: api, verifier: trusted()).load();
    expect(api.calls, 1);
  });

  group('the signed payload is byte-exact', () {
    test('matches the canonical text the controller signed', () {
      // The real risk is a mismatch between what the loader reconstructs and
      // what the signer signed: every genuine bundle would be rejected.
      final bundle = ConfigBundle.fromJson(wireBundle);
      expect(
        BundleVerifier.canonicalJson(ConfigBundleLoader.signedPayload(bundle)),
        wireBundle['signedCanonical'],
      );
    });

    test('uses the raw expiresAt string, not a re-serialised DateTime', () {
      // A DateTime round trip through Dart drops a zero fractional part
      // (…T00:00:00.000Z becomes …T00:00:00Z). If verification used that form,
      // a perfectly good bundle would be rejected as tampered.
      final bundle = ConfigBundle.fromJson({
        'expiresAt': '2026-12-01T00:00:00.000Z',
        'nodes': <dynamic>[],
        'configs': <String, dynamic>{},
      });
      expect(ConfigBundleLoader.signedPayload(bundle)['expiresAt'], '2026-12-01T00:00:00.000Z');
    });

    test('excludes transport metadata that is not signed', () {
      // keyId and signature are added after signing; including them in the
      // reconstructed payload would guarantee a mismatch.
      final payload = ConfigBundleLoader.signedPayload(ConfigBundle.fromJson(wireBundle));
      expect(payload.keys, containsAll(<String>['expiresAt', 'nodes', 'configs']));
      expect(payload.keys, isNot(contains('keyId')));
      expect(payload.keys, isNot(contains('signature')));
    });
  });

  test('the canonical fixtures are still verifiable in isolation', () async {
    // Guards the fixture file itself: if it were ever regenerated with a key
    // that no longer matches, this fails rather than silently weakening the
    // other tests.
    for (final entry in fixtures) {
      final f = entry as Map<String, dynamic>;
      expect(await trusted().verify(f['payload'] as Map<String, dynamic>, f['signature'] as String), isTrue);
    }
  });
}

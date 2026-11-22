import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/features/home/application/connection_controller.dart';

/// The node descriptor the controller hands the client, with the fields the
/// tunnel config consumes.
Map<String, dynamic> endpoint() => {
      'server': '203.0.113.7',
      'serverPort': 443,
      'uuid': '6f1c2f7a-1b1e-4f8a-9c3d-2a5e6b7c8d90',
      'serverName': 'www.example.com',
      'publicKey': 'MlqQ2J0kZ4m8tYw1c3p5r7s9u0v2x4z6b8d0f1h3j5k',
      'shortId': '0123456789abcdef',
      'flow': 'xtls-rprx-vision',
      'fingerprint': 'chrome',
    };

void main() {
  // sing-box 1.12 replaced `address` with `type` + `server` and 1.14 removed the
  // legacy form; one legacy entry makes the engine reject the entire config, so
  // this asserts the shape the pinned engine actually loads.
  test('DNS servers use the post-1.12 type/server form', () {
    final dns = buildSingBoxTunConfig(endpoint())['dns'] as Map<String, dynamic>;
    final servers = (dns['servers'] as List).cast<Map<String, dynamic>>();

    expect(servers, isNotEmpty);
    for (final server in servers) {
      expect(
        server.containsKey('address'),
        isFalse,
        reason: 'address is the legacy form removed in sing-box 1.14: $server',
      );
      expect(server['type'], isA<String>());
    }

    final remote = servers.firstWhere((server) => server['tag'] == 'remote');
    expect(remote['type'], 'https');
    expect(remote['server'], '1.1.1.1');
    expect(remote['detour'], 'proxy');

    final local = servers.firstWhere((server) => server['tag'] == 'local');
    expect(local['type'], 'local');

    expect(dns['final'], 'remote');
    expect(dns['strategy'], 'ipv4_only');
  });

  // `block`/`dns` outbounds were removed in favour of rule actions in 1.12; a
  // config that still declares one is rejected outright.
  test('declares no legacy special outbounds', () {
    final outbounds =
        (buildSingBoxTunConfig(endpoint())['outbounds'] as List).cast<Map<String, dynamic>>();
    final types = outbounds.map((outbound) => outbound['type']).toList();

    expect(types, isNot(contains('block')));
    expect(types, isNot(contains('dns')));
    expect(types.first, 'vless');
  });

  test('routes the tunnel through the selected node', () {
    final config = buildSingBoxTunConfig(endpoint());
    final inbound = (config['inbounds'] as List).first as Map<String, dynamic>;
    final outbound = (config['outbounds'] as List).first as Map<String, dynamic>;
    final route = config['route'] as Map<String, dynamic>;

    expect(inbound['type'], 'tun');
    expect(route['final'], outbound['tag']);
    expect(outbound['server'], '203.0.113.7');
    expect(outbound['server_port'], 443);
  });

  // The fallback after a crash during connect: the userspace stack and no
  // strict_route are the two settings Android OEM builds most often abort on.
  test('compat mode uses the conservative datapath', () {
    final inbound =
        (buildSingBoxTunConfig(endpoint(), compat: true)['inbounds'] as List).first
            as Map<String, dynamic>;

    expect(inbound['stack'], 'gvisor');
    expect(inbound['strict_route'], isFalse);
    expect(inbound['mtu'], tunMtu);
    expect(inbound['auto_route'], isTrue, reason: 'the tunnel still has to capture traffic');
    expect(inbound['address'], hasLength(2), reason: 'IPv6 must stay in the tunnel, not leak');
  });

  // sing-box's own default MTU is 9000; a phone radio carries 1500. Segments
  // built for a 9000-byte interface are dropped, PMTUD cannot recover from
  // inside a VPN, and every TCP connection hangs while the tunnel says
  // connected. The MTU is therefore pinned in both datapaths.
  test('the tunnel MTU stays under the phone path MTU', () {
    for (final compat in [false, true]) {
      final inbound =
          (buildSingBoxTunConfig(endpoint(), compat: compat)['inbounds'] as List).first
              as Map<String, dynamic>;
      expect(inbound['mtu'], 1400, reason: 'compat=$compat');
    }
  });

  // A silently dropped QUIC handshake stalls browsers for seconds; rejecting it
  // tells them to use TCP immediately. The Vision outbound carries no general
  // UDP, so there is nothing to gain by letting it through.
  test('rejects QUIC instead of dropping it inside the outbound', () {
    final route = buildSingBoxTunConfig(endpoint())['route'] as Map<String, dynamic>;
    final rules = (route['rules'] as List).cast<Map<String, dynamic>>();

    expect(
      rules.any((rule) =>
          rule['network'] == 'udp' &&
          rule['port'] == 443 &&
          rule['action'] == 'reject' &&
          rule['no_drop'] == true),
      isTrue,
    );
  });

  // The device's DNS arrives at the tunnel as plain UDP:53, which the VLESS
  // Vision outbound cannot carry. Without interception every app on the device
  // fails its first lookup while the tunnel still reports connected.
  test('hijacks DNS so lookups use the configured resolver', () {
    for (final compat in [false, true]) {
      final route =
          buildSingBoxTunConfig(endpoint(), compat: compat)['route'] as Map<String, dynamic>;
      final rules = (route['rules'] as List).cast<Map<String, dynamic>>();

      expect(
        rules.any((rule) => rule['action'] == 'sniff'),
        isTrue,
        reason: 'protocol matching needs sniffing, compat=$compat',
      );
      expect(
        rules.any((rule) => rule['protocol'] == 'dns' && rule['action'] == 'hijack-dns'),
        isTrue,
        reason: 'unhijacked DNS dies in the proxy outbound, compat=$compat',
      );
      expect(route['final'], 'proxy');
    }
  });

  // sing-box 1.14 refuses to start when an outbound dial has no resolver, and
  // the failure is fatal at startup: the UI can still show a connected tunnel
  // while every request fails. The tag must also name a DNS server in the same
  // config, otherwise the resolver lookup itself fails at load.
  test('every dial resolves through a configured DNS server', () {
    final config = buildSingBoxTunConfig(endpoint());
    final route = config['route'] as Map<String, dynamic>;
    final tags = ((config['dns'] as Map<String, dynamic>)['servers'] as List)
        .cast<Map<String, dynamic>>()
        .map((server) => server['tag'])
        .toSet();

    expect(route['default_domain_resolver'], isA<String>());
    expect(tags, contains(route['default_domain_resolver']));
  });

  test('the normal datapath uses gVisor with strict routing', () {
    final inbound =
        (buildSingBoxTunConfig(endpoint())['inbounds'] as List).first as Map<String, dynamic>;

    expect(inbound['stack'], 'gvisor');
    expect(inbound['strict_route'], isTrue);
    expect(inbound['mtu'], tunMtu, reason: 'the MTU is never left to the engine default');
  });
}

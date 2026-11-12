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
    expect(dns['strategy'], 'prefer_ipv4');
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
}

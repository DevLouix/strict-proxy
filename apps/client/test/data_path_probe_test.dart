import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:strict_proxy_client/features/home/application/connection_controller.dart';

/// The probe that decides whether "connected" is true in practice, not just in
/// the engine's own state: a tunnel can be up and carry nothing.
void main() {
  test('the datapath check passes when a probe endpoint answers', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) {
      request.response.statusCode = HttpStatus.noContent;
      request.response.close();
    });
    addTearDown(() => server.close(force: true));

    expect(
      await ConnectionNotifier.probeDataPath(
        urls: [Uri.parse('http://127.0.0.1:${server.port}/generate_204')],
      ),
      isTrue,
    );
  });

  test('the datapath check fails when nothing answers', () async {
    // Port 1 on loopback refuses immediately: nothing is listening.
    expect(
      await ConnectionNotifier.probeDataPath(
        urls: [Uri.parse('http://127.0.0.1:1/generate_204')],
        timeout: const Duration(milliseconds: 700),
      ),
      isFalse,
    );
  });
}

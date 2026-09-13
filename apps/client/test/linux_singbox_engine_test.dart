import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:strict_proxy_client/features/engine/engine_adapter.dart';
import 'package:strict_proxy_client/features/engine/linux_singbox_engine.dart';

void main() {
  test('Linux engine starts sing-box with a temporary config', () async {
    final calls = <List<String>>[];
    final exit = Completer<int>();
    final process = _FakeProcess(exit.future);
    final engine = LinuxSingBoxEngine(
      executable: 'sing-box',
      processStarter: (executable, args) async {
        calls.add([executable, ...args]);
        return process;
      },
    );

    await engine.connect(jsonEncode({'inbounds': [], 'outbounds': []}));

    expect(calls, hasLength(1));
    expect(calls.single[0], 'sing-box');
    expect(calls.single[1], 'run');
    expect(calls.single[2], '-c');
    expect(File(calls.single[3]).existsSync(), isTrue);
    expect(engine.state, EngineState.connected);

    exit.complete(0);
    await engine.disconnect();
    expect(engine.state, EngineState.disconnected);
    engine.dispose();
  });

  test('Linux engine rejects an empty config', () async {
    final engine = LinuxSingBoxEngine(
      processStarter: (_, __) async => _FakeProcess(Future.value(0)),
    );

    expect(
      () => engine.connect('   '),
      throwsA(isA<FormatException>()),
    );
    engine.dispose();
  });
}

class _FakeProcess implements Process {
  _FakeProcess(this._exitCode);

  final Future<int> _exitCode;

  @override
  Stream<List<int>> get stdout => const Stream.empty();

  @override
  Stream<List<int>> get stderr => const Stream.empty();

  @override
  Future<int> get exitCode => _exitCode;

  @override
  int get pid => 1;

  @override
  IOSink get stdin => throw UnimplementedError();

  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) => true;
}

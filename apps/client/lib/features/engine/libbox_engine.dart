import 'engine_adapter.dart';

/// Production engine backed by sing-box's libbox (Go mobile bindings).
///
/// INTEGRATION POINT: to enable, add `libbox` as a flutter plugin via gomobile
/// (see docs/integration-libbox.md) and replace the marked stub bodies with
/// the real libbox calls. Until then this behaves like NoopEngine so the UI
/// and flows can be developed end-to-end.
class LibboxEngine implements VpnEngine {
  final _controller = StreamController<EngineState>.broadcast();
  EngineState _state = EngineState.disconnected;

  @override
  EngineState get state => _state;

  @override
  Stream<EngineState> get stateStream => _controller.stream;

  @override
  Future<void> initialize() async {
    // TODO(integration): libbox.setWorkingPath / initialize debug server.
    _setState(EngineState.disconnected);
  }

  @override
  Future<void> connect(String singBoxConfigJson) async {
    _setState(EngineState.connecting);
    // TODO(integration): parse options via libbox.Options, build a
    // libbox.Box, register a TunService (Android VpnService /
    // NetworkExtension on iOS) and call box.Start().
    await Future<void>.delayed(const Duration(milliseconds: 600));
    _setState(EngineState.connected);
  }

  @override
  Future<void> disconnect() async {
    _setState(EngineState.disconnecting);
    // TODO(integration): box.Close().
    await Future<void>.delayed(const Duration(milliseconds: 300));
    _setState(EngineState.disconnected);
  }

  void _setState(EngineState s) {
    _state = s;
    _controller.add(s);
  }

  @override
  void dispose() => _controller.close();
}

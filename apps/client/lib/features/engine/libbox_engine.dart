import 'dart:async';
import 'package:flutter/services.dart';
import 'package:strict_proxy_libbox_bridge/libbox_bridge.dart';

import 'engine_adapter.dart';

/// Platform bridge contract for the native gomobile/libbox implementation.
///
/// Android and iOS must implement the `strict_proxy/libbox` channel methods:
/// initialize, start, stop. The native side owns TUN/VpnService/NetworkExtension
/// and calls back with `state` events: connecting, connected, disconnected, error.
class LibboxEngine implements VpnEngine {
  LibboxEngine({MethodChannel? channel})
      : _channel = channel ?? LibboxBridge.channel {
    _channel.setMethodCallHandler(_onMethodCall);
  }

  final MethodChannel _channel;
  final _controller = StreamController<EngineState>.broadcast();
  EngineState _state = EngineState.disconnected;

  @override
  EngineState get state => _state;

  @override
  Stream<EngineState> get stateStream => _controller.stream;

  @override
  Future<void> initialize() async {
    final available = await _channel.invokeMethod<bool>('isAvailable') ?? false;
    if (!available) {
      _setState(EngineState.error);
      throw StateError('libbox native artifact is unavailable for this platform build');
    }
    await _channel.invokeMethod<void>('initialize');
    _setState(EngineState.disconnected);
  }

  @override
  Future<void> connect(String singBoxConfigJson) async {
    if (singBoxConfigJson.trim().isEmpty) {
      throw const FormatException('libbox configuration cannot be empty');
    }
    _setState(EngineState.connecting);
    try {
      await _channel.invokeMethod<void>('start', {'config': singBoxConfigJson});
    } catch (error) {
      _setState(EngineState.error);
      throw StateError('libbox start failed: $error');
    }
  }

  @override
  Future<void> disconnect() async {
    _setState(EngineState.disconnecting);
    try {
      await _channel.invokeMethod<void>('stop');
      _setState(EngineState.disconnected);
    } catch (error) {
      _setState(EngineState.error);
      throw StateError('libbox stop failed: $error');
    }
  }

  Future<void> _onMethodCall(MethodCall call) async {
    if (call.method != 'state') return;
    final value = switch (call.arguments) {
      String state => state,
      Map<dynamic, dynamic> payload => payload['state'] as String? ?? 'error',
      _ => 'error',
    };
    _setState(switch (value) {
      'connecting' => EngineState.connecting,
      'connected' => EngineState.connected,
      'disconnecting' => EngineState.disconnecting,
      'disconnected' => EngineState.disconnected,
      _ => EngineState.error,
    });
  }

  void _setState(EngineState value) {
    _state = value;
    if (!_controller.isClosed) _controller.add(value);
  }

  @override
  void dispose() {
    _channel.setMethodCallHandler(null);
    _controller.close();
  }
}

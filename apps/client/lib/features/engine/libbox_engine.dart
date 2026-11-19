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
  String? _lastErrorMessage;

  @override
  EngineState get state => _state;

  @override
  String? get lastErrorMessage => _lastErrorMessage;

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
    // A new attempt starts from no error: whatever the previous one reported
    // must not be shown for this one.
    _lastErrorMessage = null;
    _setState(EngineState.connecting);
    try {
      await _channel.invokeMethod<void>('start', {'config': singBoxConfigJson});
    } catch (error) {
      _lastErrorMessage = _describePlatformError(error);
      _setState(EngineState.error);
      throw StateError(_lastErrorMessage!);
    }
  }

  @override
  Future<void> disconnect() async {
    _setState(EngineState.disconnecting);
    try {
      await _channel.invokeMethod<void>('stop');
      _setState(EngineState.disconnected);
    } catch (error) {
      // A stop the native side could not confirm carries the reason the user
      // needs ("the VPN did not shut down, turn it off in Android settings").
      // Publishing `error` without recording it is what made this path — the
      // teardown after a compat reload — show the "no reason" fallback as well.
      _lastErrorMessage = _describePlatformError(error);
      _setState(EngineState.error);
      throw StateError('libbox stop failed: $error');
    }
  }

  Future<void> _onMethodCall(MethodCall call) async {
    if (call.method != 'state') return;
    final args = call.arguments;
    final String value;
    if (args is Map) {
      value = args['state'] as String? ?? 'error';
      // The native service sends the underlying libbox message next to the
      // state; dropping it is why a failed start only ever said "engine error".
      final message = args['message'];
      if (message is String && message.trim().isNotEmpty) {
        _lastErrorMessage = message.trim();
      }
    } else if (args is String) {
      value = args;
    } else {
      value = 'error';
    }
    final next = switch (value) {
      'connecting' => EngineState.connecting,
      'connected' => EngineState.connected,
      'disconnecting' => EngineState.disconnecting,
      'disconnected' => EngineState.disconnected,
      _ => EngineState.error,
    };
    // The reason is deliberately kept across `connected`: an error that arrives
    // after the interface came up is still this attempt's failure, and clearing
    // it here is what turned it into a bare "engine error". Only a new connect
    // clears it.
    _setState(next);
  }

  static String _describePlatformError(Object error) {
    if (error is PlatformException) {
      final message = error.message?.trim();
      if (message != null && message.isNotEmpty) return message;
      return error.code;
    }
    return error.toString();
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

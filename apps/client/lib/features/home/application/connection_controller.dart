import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/presentation/auth_controller.dart';
import '../../engine/engine_adapter.dart';

/// Sealed connection state.
sealed class ConnState {
  const ConnState();
}

class EngineStateIdle extends ConnState {
  const EngineStateIdle();
}

class EngineStateConnecting extends ConnState {
  const EngineStateConnecting();
}

class EngineStateConnected extends ConnState {
  const EngineStateConnected(this.node);
  final ServerNode node;
}

class EngineStateError extends ConnState {
  const EngineStateError(this.message);
  final String message;
}

/// Measured latency probe result for a node.
class LatencyResult {
  LatencyResult(this.nodeId, this.latencyMs);
  final String nodeId;
  final int? latencyMs;
}

class ConnectionNotifier extends StateNotifier<ConnState> {
  ConnectionNotifier(this._ref) : super(const EngineStateIdle()) {
    final engine = _ref.read(engineProvider);
    engine.stateStream.listen((s) {
      // Mirror engine state transitions into the UI state machine.
      switch (s) {
        case EngineState.connecting:
          if (state is! EngineStateConnected) state = const EngineStateConnecting();
        case EngineState.connected:
          if (_selected != null) state = EngineStateConnected(_selected!);
        case EngineState.disconnecting:
        case EngineState.disconnected:
          state = const EngineStateIdle();
        case EngineState.error:
          state = const EngineStateError('engine error');
      }
    });
  }

  final Ref _ref;
  ServerNode? _selected;

  ServerNode? get selected => _selected;

  Future<void> toggle() async {
    final s = state;
    if (s is EngineStateConnected || s is EngineStateConnecting) {
      await disconnect();
    } else {
      await connect();
    }
  }

  Future<void> connect({ServerNode? node}) async {
    try {
      if (node != null) _selected = node;
      _selected ??= await pickBestNode();
      if (_selected == null) {
        state = const EngineStateError('No servers available');
        return;
      }
      state = const EngineStateConnecting();

      final api = _ref.read(apiProvider);
      final bundleJson = await api.networkConfig();
      final engine = _ref.read(engineProvider);
      final nodeConfig = (bundleJson['configs'] as Map<String, dynamic>? ?? {})[_selected!.id];
      await engine.connect(nodeConfig != null ? jsonEncode(nodeConfig) : '{}');
      // `connected` is delivered via the engine state stream.
    } catch (e) {
      state = EngineStateError(e.toString());
    }
  }

  Future<void> disconnect() async {
    await _ref.read(engineProvider).disconnect();
    state = const EngineStateIdle();
  }

  /// Chooses the lowest-latency node using parallel TCP probes.
  Future<ServerNode?> pickBestNode() async {
    final bundleJson = await _ref.read(apiProvider).networkConfig();
    final bundle = ConfigBundle.fromJson(bundleJson);
    if (bundle.nodes.isEmpty) return null;
    final results = await measureLatencies(bundle.nodes);
    ServerNode? best;
    int? bestMs;
    for (final r in results) {
      if (r.latencyMs != null && (bestMs == null || r.latencyMs! < bestMs)) {
        bestMs = r.latencyMs;
        best = bundle.nodes.firstWhere((n) => n.id == r.nodeId);
      }
    }
    best ??= bundle.nodes.first;
    _selected = best;
    return best;
  }

  /// Raw TCP connect probes: fast and dependency-free.
  Future<List<LatencyResult>> measureLatencies(List<ServerNode> nodes) async {
    final results = <LatencyResult>[];
    await Future.wait(nodes.map((n) async {
      final sw = Stopwatch()..start();
      int? ms;
      try {
        final socket = await Socket.connect(n.tunnelHost, n.tunnelPort,
            timeout: const Duration(seconds: 3));
        sw.stop();
        ms = sw.elapsedMilliseconds;
        socket.destroy();
      } catch (_) {
        ms = null;
      }
      results.add(LatencyResult(n.id, ms));
    }));
    return results;
  }
}

final engineProvider = Provider<VpnEngine>((ref) {
  // Swap for LibboxEngine() once the libbox plugin is integrated.
  final engine = NoopEngine();
  ref.onDispose(engine.dispose);
  return engine;
});

final connectionStateProvider =
    StateNotifierProvider<ConnectionNotifier, ConnState>((ref) => ConnectionNotifier(ref));

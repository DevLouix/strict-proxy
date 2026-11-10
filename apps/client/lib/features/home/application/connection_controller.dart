import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api_client.dart';
import '../../auth/presentation/auth_controller.dart';
import '../../../core/config.dart';
import '../../engine/bundle_verifier.dart';
import '../../engine/config_bundle_loader.dart';
import '../../engine/engine_adapter.dart';
import '../../engine/libbox_engine.dart';
import '../../engine/linux_singbox_engine.dart';

/// Converts the controller's compact VLESS+REALITY descriptor into a complete
/// sing-box client configuration with a system TUN inbound.
Map<String, dynamic> buildSingBoxTunConfig(Map<String, dynamic> endpoint) => {
      'log': {'level': 'warn', 'timestamp': true},
      'dns': {
        'servers': [
          {'tag': 'remote', 'address': 'https://1.1.1.1/dns-query', 'detour': 'proxy'},
          {'tag': 'local', 'address': 'local'},
        ],
        'final': 'remote',
        'strategy': 'prefer_ipv4',
      },
      'inbounds': [
        {
          'type': 'tun',
          'tag': 'tun-in',
          'interface_name': 'strictproxy0',
          'address': [AppConfig.tunIpv4Address, AppConfig.tunIpv6Address],
          'auto_route': true,
          'strict_route': true,
          'stack': 'mixed',
        },
      ],
      'outbounds': [
        {
          'type': 'vless',
          'tag': 'proxy',
          'server': endpoint['server'],
          'server_port': endpoint['serverPort'],
          'uuid': endpoint['uuid'],
          'flow': endpoint['flow'] ?? 'xtls-rprx-vision',
          'tls': {
            'enabled': true,
            'server_name': endpoint['serverName'],
            'utls': {'enabled': true, 'fingerprint': endpoint['fingerprint'] ?? 'chrome'},
            'reality': {
              'enabled': true,
              'public_key': endpoint['publicKey'],
              'short_id': endpoint['shortId'],
            },
          },
        },
        {'type': 'direct', 'tag': 'direct'},
        {'type': 'block', 'tag': 'block'},
      ],
      'route': {
        'auto_detect_interface': true,
        'final': 'proxy',
      },
    };

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
    _engineReady = _initializeEngine(engine);
    engine.stateStream.listen((s) {
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
  late final Future<void> _engineReady;
  ServerNode? _selected;

  Future<void> _initializeEngine(VpnEngine engine) async {
    try {
      await engine.initialize();
    } catch (error) {
      // Never rethrow: this future is awaited only when the user connects, so a
      // rethrow here surfaces as an unhandled async error on the home screen,
      // which can take the whole app down instead of showing the failure.
      state = EngineStateError(error.toString());
    }
  }

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
      await _engineReady;
      if (node != null) _selected = node;
      _selected ??= await pickBestNode();
      if (_selected == null) {
        state = const EngineStateError('No servers available');
        return;
      }
      state = const EngineStateConnecting();

      // Every bundle is verified by the loader before it is used; nothing else
      // is allowed to fetch and trust raw credentials.
      final bundle = await _ref.read(configBundleLoaderProvider).load();
      final nodeConfig = bundle.rawConfigs[_selected!.id];
      if (nodeConfig is! Map<String, dynamic>) {
        state = const EngineStateError('Selected server configuration is unavailable');
        return;
      }
      await _ref.read(engineProvider).connect(jsonEncode(buildSingBoxTunConfig(nodeConfig)));
    } on BundleVerificationException catch (e) {
      state = EngineStateError(e.reason);
    } on ApiException catch (e) {
      state = EngineStateError(_describeConnectFailure(e));
    } catch (e) {
      state = EngineStateError(e.toString());
    }
  }

  /// Turns an API failure into something a person can act on.
  ///
  /// Losing entitlement is the common case here, and `ApiException(402,
  /// SUBSCRIPTION_REQUIRED)` on its own tells the user nothing. These codes
  /// each mean something specific, so say what it is and what to do.
  static String _describeConnectFailure(ApiException e) =>
      describeConnectFailureForTest(e);

  /// Exposed for tests; the logic is pure and worth pinning down directly.
  @visibleForTesting
  static String describeConnectFailureForTest(ApiException e) {
    switch (e.code) {
      case 'SUBSCRIPTION_REQUIRED':
        return 'Your subscription has expired. Renew it to reconnect.';
      case 'BANDWIDTH_QUOTA_EXCEEDED':
        return 'You have used your data allowance. Upgrade to reconnect.';
      case 'NO_NODES_AVAILABLE':
        return 'No servers are available right now. Try again shortly.';
      case 'TOKEN_REVOKED':
      case 'UNAUTHENTICATED':
      case 'INVALID_REFRESH':
      case 'ACCOUNT_UNAVAILABLE':
        return 'Your session has ended. Sign in again to reconnect.';
      case 'RESET_TOKEN_INVALID':
        return 'This link has expired. Request a new reset link.';
      default:
        return e.statusCode == 0
            ? 'Cannot reach the controller. Check your connection.'
            : e.message;
    }
  }

  Future<void> disconnect() async {
    try {
      await _engineReady;
      await _ref.read(engineProvider).disconnect();
      state = const EngineStateIdle();
    } catch (error) {
      state = EngineStateError(error.toString());
    }
  }

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
        final socket = await Socket.connect(n.tunnelHost, n.tunnelPort, timeout: const Duration(seconds: 3));
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
  final engine = switch (Platform.operatingSystem) {
    'linux' => LinuxSingBoxEngine(),
    'android' || 'ios' => LibboxEngine(),
    final platform => UnsupportedEngine(platform),
  };
  ref.onDispose(engine.dispose);
  return engine;
});

final connectionStateProvider = StateNotifierProvider<ConnectionNotifier, ConnState>((ref) => ConnectionNotifier(ref));

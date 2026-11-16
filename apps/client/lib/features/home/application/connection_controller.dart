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
import 'connect_recovery.dart';

/// Converts the controller's compact VLESS+REALITY descriptor into a complete
/// sing-box client configuration with a system TUN inbound.
///
/// [compat] switches to the conservative datapath used after the engine has
/// crashed on this device: the userspace (gVisor) stack instead of the Android
/// system stack, no `strict_route` (which OEM VPN implementations mishandle),
/// and a smaller MTU so oversized packets cannot abort the session.
Map<String, dynamic> buildSingBoxTunConfig(
  Map<String, dynamic> endpoint, {
  bool compat = false,
}) =>
    {
      'log': {'level': 'warn', 'timestamp': true},
      // sing-box 1.12 replaced the `address` form with an explicit `type` and
      // `server`, and 1.14 removed the legacy form entirely. One legacy entry
      // rejects the whole config before the tunnel starts ("decode config:
      // dns.servers[0]: legacy DNS server formats ... removed"), which is what
      // "connection fails" looked like. `strategy` is a top-level option here;
      // per-server strategy is the deprecated spelling.
      'dns': {
        'servers': [
          {'type': 'https', 'tag': 'remote', 'server': '1.1.1.1', 'detour': 'proxy'},
          {'type': 'local', 'tag': 'local'},
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
          'strict_route': !compat,
          'stack': compat ? 'gvisor' : 'mixed',
          if (compat) 'mtu': 1400,
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
        // `block` was a legacy special outbound, removed in sing-box 1.12 in
        // favour of the `reject` rule action. It was never referenced by a route
        // rule, so dropping it changes no behaviour — but 1.14 refuses to load a
        // config that declares it.
      ],
      'route': {
        'auto_detect_interface': true,
        // DNS has to be answered by the engine, not proxied as-is. The device's
        // queries reach the tunnel as plain UDP:53; the final outbound is VLESS
        // with the Vision flow, which carries no UDP at all, so without these
        // two rules every app on the device times out on its first lookup while
        // the tunnel still reports connected. `sniff` is what lets the
        // `protocol: dns` matcher below recognise a query at all.
        'rules': [
          {'action': 'sniff'},
          {'protocol': 'dns', 'action': 'hijack-dns'},
        ],
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
  ConnectionNotifier(this._ref, {ConnectRecovery? recovery})
      : _recovery = recovery ?? ConnectRecovery(),
        super(const EngineStateIdle()) {
    _engine = _ref.read(engineProvider);
    _engineReady = _initializeEngine(_engine);
    _subscription = _engine.stateStream.listen(_onEngineState);
    _recoveryReady = _recoverFromCrash();
  }

  /// How long an attempt may stay in "connecting" before it is reported as
  /// failed. The native start covers the OS VPN permission dialog, which a user
  /// can sit on, so this is deliberately generous — but bounded, because the
  /// engine could otherwise stay in ``connecting`` forever with no feedback.
  static const connectTimeout = Duration(seconds: 45);

  final Ref _ref;
  late final VpnEngine _engine;
  late final Future<void> _engineReady;
  final ConnectRecovery _recovery;
  late final Future<void> _recoveryReady;
  StreamSubscription<EngineState>? _subscription;

  /// Applies the fallback the previous launch earned: a crash during connect
  /// means the current settings are unsafe on this device.
  Future<void> _recoverFromCrash() async {
    try {
      if (await _recovery.resolveAfterUncleanExit()) {
        _ref.read(compatModeProvider.notifier).state = true;
      }
    } catch (_) {
      // Recovery is best effort; nothing here may stop the app from starting.
    }
  }

  /// Leaves the conservative settings, at the user's request.
  Future<void> clearCompatMode() async {
    await _recovery.clearCompat();
    _ref.read(compatModeProvider.notifier).state = false;
  }

  /// Switches to the safe settings when the engine process died from a crash,
  /// so a retry is not the same attempt that just failed.
  Future<void> _learnFromEngineDeath() async {
    try {
      if (await _recovery.noteEngineCrash()) {
        _ref.read(compatModeProvider.notifier).state = true;
      }
    } catch (_) {
      // Diagnosis is best effort; the error state is already on screen.
    }
  }

  /// Fails an attempt that reports neither `connected` nor an error.
  Timer? _watchdog;

  /// Monotonic attempt id, so a stale `await` cannot overwrite a newer attempt.
  int _attempt = 0;

  /// Set when the current attempt failed. The native service emits an error and
  /// then `disconnected` from `onDestroy`; without this flag that trailing event
  /// turned a failed connect into "idle" — the state flicker users saw as
  /// "it just goes back to disconnected".
  bool _failed = false;

  /// Populated when the engine cannot be initialised, so connect fails with the
  /// real reason instead of attempting a session the build cannot support.
  String? _engineError;

  ServerNode? _selected;

  Future<void> _initializeEngine(VpnEngine engine) async {
    try {
      await engine.initialize();
    } catch (error) {
      // Never rethrow: this future is awaited only when the user connects, so a
      // rethrow here surfaces as an unhandled async error on the home screen,
      // which can take the whole app down instead of showing the failure.
      _engineError = _describeError(error);
      state = EngineStateError(_engineError!);
    }
  }

  void _onEngineState(EngineState event) {
    switch (event) {
      case EngineState.connecting:
        if (state is! EngineStateConnected && state is! EngineStateConnecting) {
          state = const EngineStateConnecting();
        }
      case EngineState.connected:
        _watchdog?.cancel();
        _failed = false;
        unawaited(_recovery.endAttempt());
        final node = _selected;
        if (node != null) state = EngineStateConnected(node);
      case EngineState.disconnecting:
        _watchdog?.cancel();
        if (!_failed) state = const EngineStateIdle();
      case EngineState.disconnected:
        _watchdog?.cancel();
        if (!_failed) state = const EngineStateIdle();
      case EngineState.error:
        _watchdog?.cancel();
        _failed = true;
        final wasConnected = state is EngineStateConnected;
        state = EngineStateError(
          _engine.lastErrorMessage ?? 'The VPN engine reported an error.',
        );
        // The engine runs in its own process now, so losing it while the tunnel
        // was up is survivable — and worth learning from before the next try.
        if (wasConnected) unawaited(_learnFromEngineDeath());
    }
  }

  ServerNode? get selected => _selected;

  Future<void> toggle() async {
    final s = state;
    if (s is EngineStateConnected || s is EngineStateConnecting) {
      // While connecting this is a cancel, not a disconnect; the UI says so.
      await disconnect();
    } else {
      await connect();
    }
  }

  Future<void> connect({ServerNode? node}) async {
    // A tap while an attempt is in flight must not start a second one; the
    // button reports that tap as a cancel through [toggle].
    if (state is EngineStateConnecting) return;

    final attempt = ++_attempt;
    _failed = false;
    _watchdog?.cancel();

    try {
      await _engineReady;
      if (attempt != _attempt) return;
      if (_engineError != null) {
        _fail(_engineError!);
        return;
      }
      if (node != null) _selected = node;
      _selected ??= await pickBestNode();
      if (attempt != _attempt) return;
      if (_selected == null) {
        _fail('No servers are available right now. Try again shortly.');
        return;
      }
      state = const EngineStateConnecting();

      // Marked before the engine starts: if the process dies here, this marker
      // is the only record that a start was in flight.
      await _recoveryReady;
      await _recovery.beginAttempt();

      // Nothing can report progress while the OS VPN permission dialog is up, so
      // the watchdog covers the whole attempt, not just the tunnel handshake.
      _watchdog = Timer(connectTimeout, () {
        if (attempt != _attempt || state is! EngineStateConnecting) return;
        _fail(
          'The tunnel did not come up. Allow the VPN request if it is showing, '
          'then try again.',
        );
      });

      // Every bundle is verified by the loader before it is used; nothing else
      // is allowed to fetch and trust raw credentials.
      final bundle = await _ref.read(configBundleLoaderProvider).load();
      if (attempt != _attempt) return;
      final nodeConfig = bundle.rawConfigs[_selected!.id];
      if (nodeConfig is! Map<String, dynamic>) {
        _fail('The selected server configuration is unavailable. Pick another server.');
        return;
      }
      await _engine.connect(jsonEncode(buildSingBoxTunConfig(
        nodeConfig,
        compat: _ref.read(compatModeProvider),
      )));
    } on BundleVerificationException catch (e) {
      _fail(e.reason);
    } on ApiException catch (e) {
      _fail(_describeConnectFailure(e));
    } catch (e) {
      _fail(_engine.lastErrorMessage ?? _describeError(e));
    }
  }

  /// Records a failed attempt. Cancels the watchdog and keeps later
  /// `disconnected` events from wiping the reason off the screen.
  void _fail(String message) {
    _watchdog?.cancel();
    _failed = true;
    unawaited(_recovery.endAttempt());
    state = EngineStateError(message);
  }

  /// Turns an engine error into text a person can read.
  ///
  /// `StateError('libbox start failed: PlatformException(...)')` and a bare
  /// exception string are developer text, not a user-facing reason.
  static String _describeError(Object error) {
    final text = error is StateError ? error.message : error.toString();
    final trimmed = text.trim();
    return trimmed.isEmpty ? 'The tunnel could not be started.' : trimmed;
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
    // Invalidate any attempt still in flight before stopping the engine.
    _attempt++;
    _watchdog?.cancel();
    _failed = false;
    unawaited(_recovery.endAttempt());
    try {
      await _engineReady;
      await _engine.disconnect();
      state = const EngineStateIdle();
    } catch (error) {
      state = EngineStateError(_describeError(error));
    }
  }

  @override
  void dispose() {
    _watchdog?.cancel();
    _subscription?.cancel();
    super.dispose();
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

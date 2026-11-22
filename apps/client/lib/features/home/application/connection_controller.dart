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
import '../../updates/update_controller.dart';
import 'connect_recovery.dart';

/// TUN MTU used on every device.
///
/// sing-box's own default is 9000. A phone's radio is 1500, path-MTU discovery
/// cannot work from inside a VPN, and the segments an app builds for a
/// 9000-byte interface never fit the physical link — so TCP connections (the
/// DoH resolver included) stall while the tunnel still reports `connected`.
/// 1400 stays under the IPv4/IPv6 overhead of a normal cellular or Wi-Fi path.
const int tunMtu = 1400;

/// Converts the controller's compact VLESS+REALITY descriptor into a complete
/// sing-box client configuration with a system TUN inbound.
///
/// [compat] switches to the conservative datapath used after the engine has
/// crashed on this device: the userspace (gVisor) stack, no `strict_route`
/// (which OEM VPN implementations mishandle), and no `sniff` dependency in the
/// datapath.
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
          'mtu': tunMtu,
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
        // 1.14 makes a dial without a resolver a fatal startup error, so this
        // is load-bearing rather than a tidy-up: the engine refuses to start
        // (and the tunnel reports connected with no traffic) without it. The
        // proxy server is an IP, so `local` only resolves names the engine has
        // to look up before dialling — never the tunnel's own endpoint, which
        // would loop.
        'default_domain_resolver': 'local',
        // DNS has to be answered by the engine, not proxied as-is. The device's
        // queries reach the tunnel as plain UDP:53; the final outbound is VLESS
        // with the Vision flow, which carries no UDP at all, so without these
        // two rules every app on the device times out on its first lookup while
        // the tunnel still reports connected. `sniff` is what lets the
        // `protocol: dns` matcher below recognise a query at all.
        // QUIC is rejected explicitly rather than left to fail inside the
        // VLESS Vision outbound, which carries no general UDP: a silently
        // dropped handshake makes browsers wait on a dead connection before
        // falling back to TCP, which reads as "no internet" on the device.
        'rules': [
          {'action': 'sniff'},
          {'protocol': 'dns', 'action': 'hijack-dns'},
          {'network': 'udp', 'port': 443, 'action': 'reject'},
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

/// The engine has been asked to stop and the tunnel/interface may still be up.
///
/// This state exists so the UI never says "Disconnected" before the platform
/// has actually torn the VPN down — the exact gap that left the VPN key in the
/// status bar after a disconnect that had only changed the app's own state.
class EngineStateDisconnecting extends ConnState {
  const EngineStateDisconnecting();
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

  /// The account-level proxy session this install owns, minted by the
  /// controller on connect. A newer install claiming the same account gets a
  /// different id, which is how this one learns it has been superseded.
  String? _sessionId;

  /// Polls the controller while connected so an install that lost its session
  /// closes its own tunnel instead of sitting "connected" with revoked
  /// credentials and no working traffic.
  Timer? _sessionWatch;

  /// How often a connected client re-checks that it still holds a seat.
  static const sessionCheckInterval = Duration(seconds: 45);

  /// Endpoints that prove the tunnel carries real traffic.
  ///
  /// The engine publishes `connected` once the tun is up, which says nothing
  /// about whether packets make it out through the proxy: a dead DNS path or a
  /// datapath the device cannot use looks exactly like a working tunnel in that
  /// state. These are plain HTTPS GETs from the app itself, so they traverse the
  /// tun, the DNS hijack and the proxy outbound in one check.
  ///
  /// The target is the controller's own `/healthz`, not a public CDN. The old
  /// pair (a Cloudflare trace and a Google 204) failed on networks that filter
  /// those hosts even though the user's own destinations work — and the app
  /// disconnected a working tunnel over it. Our endpoint is also the one host
  /// the app already requires, so it adds no new dependency.
  static List<Uri> get dataPathProbes {
    try {
      return <Uri>[Uri.parse('${AppConfig.controllerUrl}/healthz')];
    } catch (_) {
      // A build with an unusable controller URL cannot connect anyway; the
      // empty list makes the probe pass rather than blaming the tunnel.
      return const <Uri>[];
    }
  }

  static const dataPathProbeTimeout = Duration(seconds: 8);

  /// True once this run already fell back to compat mode for a dead datapath,
  /// so a second failed probe reports the failure instead of reconnecting
  /// forever.
  bool _autoCompatTried = false;

  ServerNode? _selected;

  /// True once this attempt asked the engine to start, so a failure knows there
  /// may be a tunnel to take down.
  bool _engineStarted = false;

  /// The per-node config from the last bundle, kept so the compat fallback can
  /// reload the engine without another round trip.
  ///
  /// Retrying through `connect()` re-claimed the session and re-fetched the
  /// bundle over the tunnel that had just failed its probe, so the fallback
  /// itself died with "cannot reach the controller" and left the dead tunnel
  /// up. The endpoint is already signed and verified; only datapath options
  /// change.
  Map<String, dynamic>? _activeEndpoint;

  /// The session id the config request must present, when one was claimed.
  String? get sessionId => _sessionId;

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
        // A start that finishes after the attempt was already failed must not
        // revive the tunnel: `_fail` has taken it down and the screen says so.
        if (_failed) {
          unawaited(_stopEngineAfterFailure());
          return;
        }
        _failed = false;
        unawaited(_recovery.endAttempt());
        _startSessionWatch();
        final node = _selected;
        if (node != null) state = EngineStateConnected(node);
        // `connected` only means the interface exists. Verify it actually
        // carries traffic, because a tunnel that silently drops everything is
        // otherwise indistinguishable from a working one.
        unawaited(_verifyDataPath());
      case EngineState.disconnecting:
        _watchdog?.cancel();
        if (!_failed) state = const EngineStateDisconnecting();
      case EngineState.disconnected:
        _watchdog?.cancel();
        if (!_failed) state = const EngineStateIdle();
      case EngineState.error:
        _watchdog?.cancel();
        _failed = true;
        final wasConnected = state is EngineStateConnected;
        state = EngineStateError(
          _engine.lastErrorMessage ??
              'The VPN engine stopped without reporting a reason '
                  '(device log tag StrictProxyLibbox).',
        );
        // The engine runs in its own process now, so losing it while the tunnel
        // was up is survivable — and worth learning from before the next try.
        if (wasConnected) unawaited(_learnFromEngineDeath());
    }
  }

  /// Follows up `connected` with a real request through the tunnel.
  ///
  /// The normal datapath is tried first; if it carries nothing, the conservative
  /// one is applied and the tunnel reloaded once. If that also carries nothing,
  /// the app says so instead of showing a green "Connected" over a dead link.
  Future<void> _verifyDataPath() async {
    final attempt = _attempt;
    // Routes and the DNS hijack settle a moment after the interface comes up.
    await Future<void>.delayed(const Duration(seconds: 2));
    if (attempt != _attempt || state is! EngineStateConnected) return;
    String? reason;
    if (await probeDataPath(onError: (error) => reason ??= describeProbeError(error))) {
      _autoCompatTried = false;
      return;
    }
    if (attempt != _attempt || state is! EngineStateConnected) return;

    if (!_ref.read(compatModeProvider) && !_autoCompatTried) {
      _autoCompatTried = true;
      await _recovery.enableCompat();
      _ref.read(compatModeProvider.notifier).state = true;
      if (attempt != _attempt || state is! EngineStateConnected) return;
      // Reloading the engine in place applies the compat datapath without
      // tearing down the session the controller just minted — and without a
      // network round trip. Going back through connect() re-claimed the session
      // and re-fetched the bundle through the tunnel that had just carried
      // nothing, so the fallback itself failed with "cannot reach the
      // controller" and left a dead tunnel up on the device.
      final endpoint = _activeEndpoint;
      if (endpoint != null) {
        try {
          await _engine.connect(jsonEncode(buildSingBoxTunConfig(endpoint, compat: true)));
          return;
        } catch (error) {
          _fail(_engine.lastErrorMessage ?? _describeError(error));
          return;
        }
      }
    }

    await disconnect();
    _fail(
      'The tunnel is up but no traffic is getting through it'
      '${reason == null ? '' : ' ($reason)'}. Try another server, or contact '
      'support if every server does this.',
    );
  }

  /// A short reason for a failed data-path probe.
  ///
  /// The three ways a probe dies mean different things: a name that cannot be
  /// resolved points at the DNS hijack, a refused connection at the node's
  /// tunnel port, a failed handshake at the node's REALITY credentials. Saying
  /// "no traffic" for all three is what made this failure unactionable.
  @visibleForTesting
  static String describeProbeError(Object error) {
    if (error is HandshakeException) return 'the secure handshake failed';
    final text = error.toString().toLowerCase();
    if (text.contains('failed host lookup') || text.contains('no address associated')) {
      return 'the name could not be resolved';
    }
    if (text.contains('connection refused')) return 'the server refused the connection';
    if (text.contains('timed out') || text.contains('timeout')) return 'the connection timed out';
    return 'the request failed';
  }

  /// True when at least one probe endpoint answers through the tunnel.
  @visibleForTesting
  static Future<bool> probeDataPath({
    Iterable<Uri>? urls,
    Duration timeout = dataPathProbeTimeout,
    void Function(Object error)? onError,
  }) async {
    final targets = (urls ?? dataPathProbes).toList(growable: false);
    if (targets.isEmpty) return true;
    // A client per target, closed immediately: reusing one would let a pooled
    // socket opened before the tunnel existed answer 200 while the tunnel
    // carries nothing — the false "connected" this probe exists to prevent.
    final results = await Future.wait(targets.map((uri) async {
      final client = HttpClient()..connectionTimeout = timeout;
      try {
        final request = await client.getUrl(uri).timeout(timeout);
        request.headers.set(HttpHeaders.cacheControlHeader, 'no-cache');
        request.headers.set(HttpHeaders.connectionHeader, 'close');
        final response = await request.close().timeout(timeout);
        await response.drain<void>().timeout(timeout);
        return response.statusCode >= 200 && response.statusCode < 400;
      } catch (error) {
        onError?.call(error);
        return false;
      } finally {
        client.close(force: true);
      }
    }));
    return results.any((reachable) => reachable);
  }

  ServerNode? get selected => _selected;

  Future<void> toggle() async {
    final s = state;
    if (s is EngineStateDisconnecting) return;
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
      // Claim this install's seat before any credentials are fetched: a claim
      // beyond the plan displaces the least-recently-seen install, and the
      // bundle request then revokes that install's credentials server-side.
      _sessionId = await _claimSession();
      if (attempt != _attempt) return;

      if (node != null) _selected = node;
      _selected ??= await pickBestNode(sessionId: _sessionId);
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
      final bundle = await _ref.read(configBundleLoaderProvider).load(sessionId: _sessionId);
      if (attempt != _attempt) return;
      // The node picked by a previous attempt can be absent from this bundle —
      // it went offline, its engine was reported down, or the tier's node cap
      // moved it out. Holding on to it made every retry fail with "the selected
      // server configuration is unavailable", including the Try again button,
      // with no way back from this screen. Fall back to a node the bundle
      // actually carries instead of refusing to connect at all.
      if (_selected == null || bundle.rawConfigs[_selected!.id] is! Map<String, dynamic>) {
        final usable = bundle.nodes
            .where((node) => bundle.rawConfigs[node.id] is Map<String, dynamic>)
            .toList(growable: false);
        if (usable.isEmpty) {
          _fail('No servers are available right now. Try again shortly.');
          return;
        }
        _selected = usable.first;
      }
      final nodeConfig = bundle.rawConfigs[_selected!.id];
      if (nodeConfig is! Map<String, dynamic>) {
        _fail('The selected server configuration is unavailable. Pick another server.');
        return;
      }
      _activeEndpoint = nodeConfig;
      _engineStarted = true;
      await _engine.connect(jsonEncode(buildSingBoxTunConfig(
        nodeConfig,
        compat: _ref.read(compatModeProvider),
      )));
    } on BundleVerificationException catch (e) {
      _fail(e.reason);
    } on ApiException catch (e) {
      // A refused build is fixable in one tap, so record the refusal and ask
      // the updater for the published release now; the home banner then offers
      // the install instead of leaving the user with an error and no route.
      if (e.code == 'CLIENT_UPDATE_REQUIRED') {
        unawaited(_ref.read(updateProvider.notifier).requireUpdate(e.message));
      }
      _fail(_describeConnectFailure(e));
    } catch (e) {
      _fail(_engine.lastErrorMessage ?? _describeError(e));
    }
  }

  // There used to be a second check here that called the controller's health
  // endpoint through the shared API client. That client keeps connections
  // alive, so the request could travel over a socket opened *before* the tunnel
  // existed: it answered 200 with the tunnel carrying nothing, which is the one
  // false "connected" the probe below exists to prevent. A fresh-socket probe
  // (`probeDataPath`) is the check that means something.

  /// Records a failed attempt. Cancels the watchdog and keeps later
  /// `disconnected` events from wiping the reason off the screen.
  ///
  /// A failure after the engine was started also takes the tunnel down: a tun
  /// with no datapath blocks every app on the device, and leaving it running
  /// while the screen says "not connected" left the user with no way back
  /// except the notification or another VPN app.
  void _fail(String message) {
    final tunnelUp = _engineStarted;
    _watchdog?.cancel();
    _sessionWatch?.cancel();
    _sessionWatch = null;
    _failed = true;
    unawaited(_recovery.endAttempt());
    state = EngineStateError(message);
    if (tunnelUp) unawaited(_stopEngineAfterFailure());
  }

  /// Stops an engine left running by a failed attempt.
  ///
  /// The failure message stays on screen: `_failed` is already set, so the
  /// engine's `disconnecting`/`disconnected` events cannot overwrite it.
  Future<void> _stopEngineAfterFailure() async {
    try {
      await _engine.disconnect();
    } catch (_) {
      // Nothing left to stop; the failure message is what the user needs.
    } finally {
      _engineStarted = false;
    }
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
      case 'SESSION_SUPERSEDED':
        return 'Your account connected on another device, so this session was closed.';
      case 'CLIENT_UPDATE_REQUIRED':
        return 'This build of StrictProxy can no longer connect. Update the app to continue.';
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

  /// Claims a seat for this install.
  ///
  /// Returns null when the install has no device identity yet: the controller
  /// then falls back to the previous per-account behaviour instead of refusing
  /// to connect over a locally missing id.
  Future<String?> _claimSession() async {
    final api = _ref.read(apiProvider);
    final deviceId = await api.tokens.deviceId;
    if (deviceId == null || deviceId.trim().isEmpty) return null;
    final claim = await api.claimSession(deviceId);
    final claimed = claim['sessionId'];
    return claimed is String && claimed.isNotEmpty ? claimed : null;
  }

  void _startSessionWatch() {
    _sessionWatch?.cancel();
    _sessionWatch = Timer.periodic(
      sessionCheckInterval,
      (_) => unawaited(_checkSession()),
    );
  }

  /// True when the controller says this install still owns the account session.
  Future<void> _checkSession() async {
    final session = _sessionId;
    if (session == null || state is! EngineStateConnected) return;
    try {
      final status = await _ref.read(apiProvider).sessionStatus(session);
      if (status['current'] == false) await _closeSupersededSession();
    } on ApiException {
      // Most likely the tunnel itself is the reason the controller is
      // unreachable; the next interval tries again.
    } catch (_) {
      // Never let a background check take the app down.
    }
  }

  /// Ends this install's tunnel because another device took the session.
  Future<void> _closeSupersededSession() async {
    _sessionWatch?.cancel();
    _sessionWatch = null;
    await disconnect();
    _failed = true;
    state = const EngineStateError(
      'Your account connected on another device, so this session was closed.',
    );
  }

  Future<void> disconnect() async {
    // Invalidate any attempt still in flight before stopping the engine.
    _attempt++;
    _watchdog?.cancel();
    _sessionWatch?.cancel();
    _sessionWatch = null;
    _failed = false;
    unawaited(_recovery.endAttempt());
    try {
      await _engineReady;
      // The engine reports `disconnecting` and only reports `disconnected`
      // once the platform has torn the interface down; a stop that could not be
      // confirmed surfaces as an error instead of a false "Disconnected".
      await _engine.disconnect();
      _engineStarted = false;
      state = const EngineStateIdle();
    } catch (error) {
      state = EngineStateError(_describeError(error));
    }
  }

  @override
  void dispose() {
    _watchdog?.cancel();
    _sessionWatch?.cancel();
    _subscription?.cancel();
    super.dispose();
  }

  Future<ServerNode?> pickBestNode({String? sessionId}) async {
    final bundleJson =
        await _ref.read(apiProvider).networkConfig(sessionId: sessionId);
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

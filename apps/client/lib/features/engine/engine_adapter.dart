/// Engine-agnostic VPN engine adapter.
///
/// The app never talks to sing-box directly; it only feeds the dynamic JSON
/// configuration from the Central Controller into this interface. Swapping
/// the engine (or mocking it in tests) requires no UI changes.
library;

import 'dart:async';

/// A single server entry from the signed config bundle.
class ServerNode {
  ServerNode({
    required this.id,
    required this.hostname,
    required this.label,
    required this.region,
    required this.publicIp,
    required this.status,
    required this.loadScore,
    required this.tunnelHost,
    required this.tunnelPort,
    this.latencyMs,
  });

  final String id;
  final String hostname;
  final String label;
  final String region;
  final String publicIp;
  final String status;
  final int loadScore;
  final String tunnelHost;
  final int tunnelPort;

  /// Measured RTT in ms (null = not yet measured).
  int? latencyMs;

  factory ServerNode.fromJson(Map<String, dynamic> json) => ServerNode(
        id: json['id'] as String,
        hostname: json['hostname'] as String,
        label: json['label'] as String? ?? json['region'] as String,
        region: json['region'] as String,
        publicIp: json['publicIp'] as String,
        status: json['status'] as String,
        loadScore: (json['loadScore'] as num).toInt(),
        tunnelHost: json['tunnelHost'] as String,
        tunnelPort: (json['tunnelPort'] as num).toInt(),
      );
}

/// Parsed form of the controller's signed config bundle.
class ConfigBundle {
  ConfigBundle({
    required this.expiresAt,
    required this.nodes,
    required this.rawConfigs,
    required this.signature,
    required this.keyId,
    required this.rawJson,
  });

  final DateTime expiresAt;
  final List<ServerNode> nodes;
  /// Raw per-node sing-box outbound config keyed by node id.
  final Map<String, dynamic> rawConfigs;

  /// Ed25519 signature over the canonical JSON of {expiresAt, nodes, configs},
  /// base64. Carried for callers that verify; see [signatureVerified].
  final String signature;

  /// Key id the signature was made with, for rotation.
  final String keyId;

  bool get isExpired => DateTime.now().isAfter(expiresAt);


  /// The raw `nodes` and `configs` exactly as received, kept so the signed
  /// payload can be reproduced byte for byte at verification time.
  final Map<String, dynamic> rawJson;

  factory ConfigBundle.fromJson(Map<String, dynamic> json) {
    final nodesJson = (json['nodes'] as List<dynamic>? ?? const []);
    final configsJson = (json['configs'] as Map<String, dynamic>? ?? const {});
    return ConfigBundle(
      expiresAt: DateTime.parse(json['expiresAt'] as String),
      nodes: nodesJson.map((e) => ServerNode.fromJson(e as Map<String, dynamic>)).toList(),
      rawConfigs: configsJson,
      signature: json['signature'] as String? ?? '',
      keyId: json['keyId'] as String? ?? '',
      rawJson: json,
    );
  }
}

enum EngineState { disconnected, connecting, connected, disconnecting, error }

/// Abstract engine. Production builds use [LibboxEngine]; tests and desktop
/// previews can use [NoopEngine].
abstract class VpnEngine {
  Future<void> initialize();
  /// Starts the TUN session with the sing-box config JSON for the chosen node.
  Future<void> connect(String singBoxConfigJson);
  Future<void> disconnect();
  EngineState get state;
  Stream<EngineState> get stateStream;
  void dispose();
}

/// Engine that fails closed on unsupported desktop platforms.
class UnsupportedEngine implements VpnEngine {
  const UnsupportedEngine(this.platform);

  final String platform;

  StateError _unsupported() =>
      StateError('VPN engine is not available on $platform');

  @override
  EngineState get state => EngineState.error;

  @override
  Stream<EngineState> get stateStream => const Stream<EngineState>.empty();

  @override
  Future<void> initialize() async => throw _unsupported();

  @override
  Future<void> connect(String singBoxConfigJson) async => throw _unsupported();

  @override
  Future<void> disconnect() async => throw _unsupported();

  @override
  void dispose() {}
}

/// Stub engine used in tests / non-VPN build modes. Simulates a session.
class NoopEngine implements VpnEngine {
  final _controller = StreamController<EngineState>.broadcast();
  EngineState _state = EngineState.disconnected;

  @override
  EngineState get state => _state;

  @override
  Stream<EngineState> get stateStream => _controller.stream;

  @override
  Future<void> initialize() async {}

  @override
  Future<void> connect(String singBoxConfigJson) async {
    _setState(EngineState.connecting);
    await Future<void>.delayed(const Duration(milliseconds: 600));
    _setState(EngineState.connected);
  }

  @override
  Future<void> disconnect() async {
    _setState(EngineState.disconnecting);
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

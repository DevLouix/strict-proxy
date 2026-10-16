import 'dart:convert';

import 'package:cryptography/cryptography.dart';

/// Verifies the Ed25519 signature the controller puts on a config bundle.
///
/// The signature covers canonical JSON of `{expiresAt, nodes, configs}` — sorted
/// keys, no whitespace, `undefined` dropped. The Dart implementation must match
/// the controller's `canonicalJson` byte for byte, or every bundle fails to
/// verify. `canonicalJson` below is the Dart mirror of that function and is
/// pinned by tests against fixtures produced by the controller.
class BundleVerifier {
  BundleVerifier({required this.publicKeyBytes, Ed25519? algorithm})
      : algorithm = algorithm ?? Ed25519();

  /// The 32 raw bytes of the Ed25519 public key.
  final List<int> publicKeyBytes;

  final Ed25519 algorithm;

  /// Whether [publicKeyBytes] is a plausible Ed25519 public key.
  bool get isUsable => publicKeyBytes.length == 32;

  /// Serialises [payload] the way the controller's `canonicalJson` does.
  ///
  /// Object keys are sorted by UTF-16 code unit, matching JavaScript's default
  /// string comparison, which is what `Array.prototype.sort` uses.
  static String canonicalJson(Object? value) {
    if (value == null) return 'null';
    if (value is num) {
      if (value is double && value == value.roundToDouble() && value.isFinite) {
        return value.toInt().toString();
      }
      return value.toString();
    }
    if (value is bool) return value ? 'true' : 'false';
    if (value is String) return jsonEncode(value);
    if (value is List) return '[${value.map(canonicalJson).join(',')}]';
    if (value is Map) {
      final keys = value.keys.whereType<String>().toList()..sort();
      final parts = <String>[];
      for (final key in keys) {
        final entry = value[key];
        if (entry == null) continue; // matches `filter(v !== undefined)`
        parts.add('${jsonEncode(key)}:${canonicalJson(entry)}');
      }
      return '{${parts.join(',')}}';
    }
    return jsonEncode(value.toString());
  }

  /// The exact bytes the controller signed.
  static List<int> signedBytes(Map<String, dynamic> payload) =>
      utf8.encode(canonicalJson(payload));

  /// Verifies [signatureBase64] over [payload].
  ///
  /// Returns false rather than throwing for any input, including a malformed
  /// key or signature: a bundle that cannot be checked must not be treated as
  /// checked.
  Future<bool> verify(Map<String, dynamic> payload, String signatureBase64) async {
    if (!isUsable || signatureBase64.isEmpty) return false;
    try {
      final signature = Signature(
        base64Decode(signatureBase64),
        publicKey: SimplePublicKey(publicKeyBytes, type: KeyPairType.ed25519),
      );
      // `await` inside the try is essential: `verify` returns a Future and
      // rejects asynchronously, so returning it directly lets the exception
      // escape past this catch entirely.
      return await algorithm.verify(signedBytes(payload), signature: signature);
    } catch (_) {
      // Malformed base64, a wrong-length key or signature, and anything else:
      // not verified. Never throw, never "assume it was fine".
      return false;
    }
  }
}

/// Raised when a bundle cannot be trusted. Failing closed is the point: an
/// unverifiable bundle must never reach the tunnel.
class BundleVerificationException implements Exception {
  const BundleVerificationException(this.reason);

  /// Human-readable explanation, safe to show a user.
  final String reason;

  @override
  String toString() => reason;
}
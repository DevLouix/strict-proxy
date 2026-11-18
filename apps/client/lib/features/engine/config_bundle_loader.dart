import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/presentation/auth_controller.dart';
import '../../core/api_client.dart';
import '../../core/config.dart';
import 'bundle_verifier.dart';
import 'engine_adapter.dart';

/// Fetches a config bundle and refuses to return one it cannot verify.
///
/// This is the single place a bundle enters the app, so verification lives here
/// rather than being left to each caller. Failing closed is deliberate: if a
/// production build has no signing key, or a signature does not check out, the
/// tunnel is refused rather than built from unverified credentials.
class ConfigBundleLoader {
  ConfigBundleLoader({required ControllerApi api, BundleVerifier? verifier, bool? requireSignature})
      : _api = api,
        _verifier = verifier ?? _verifierFromConfig(),
        requireSignature = requireSignature ?? AppConfig.requireBundleSignature;

  final ControllerApi _api;
  final BundleVerifier? _verifier;

  /// When true, a bundle without a usable signature is refused.
  final bool requireSignature;

  static BundleVerifier? _verifierFromConfig() {
    if (!AppConfig.hasSigningPublicKey) return null;
    final bytes = AppConfig.signingPublicKeyBytes;
    if (bytes.length != 32) return null;
    return BundleVerifier(publicKeyBytes: bytes);
  }

  /// The exact fields the controller signs.
  ///
  /// `expiresAt` is taken as the raw JSON string rather than re-serialised from
  /// the parsed [DateTime]: Dart's `toIso8601String()` omits a zero fractional
  /// part, turning `...T00:00:00.000Z` into `...T00:00:00Z`. That single
  /// character is enough to fail verification, and the failure would look like a
  /// tampered bundle. Only the bytes the server actually signed will do.
  static Map<String, dynamic> signedPayload(ConfigBundle bundle) => <String, dynamic>{
        'expiresAt': bundle.rawJson['expiresAt'] as String,
        'nodes': (bundle.rawJson['nodes'] as List? ?? const []).cast<Map<String, dynamic>>(),
        'configs': bundle.rawJson['configs'] as Map<String, dynamic>? ?? const <String, dynamic>{},
      };

  /// Fetches, parses and verifies a bundle.
  ///
  /// [sessionId] identifies the caller's account session, so a device that has
  /// been superseded by a newer one is refused instead of handed credentials
  /// that would displace the new session.
  ///
  /// Throws [BundleVerificationException] when the bundle cannot be trusted.
  Future<ConfigBundle> load({String? sessionId}) async {
    final json = await _api.networkConfig(sessionId: sessionId);
    final bundle = ConfigBundle.fromJson(json);

    if (bundle.isExpired) {
      throw const BundleVerificationException('This server configuration has expired. Reconnecting…');
    }

    final verifier = _verifier;
    if (verifier == null || !verifier.isUsable) {
      // No key: acceptable in development, never in production.
      if (requireSignature) {
        throw const BundleVerificationException(
          'This build cannot verify server configurations, so it will not connect. Reinstall with a signing key.',
        );
      }
      return bundle;
    }

    // A rotated key is expected during a rollout, but an unexpected id is a
    // signal worth surfacing rather than silently ignoring.
    // The signature is checked with the configured key, so a keyId that differs
    // from STRICT_SIGNING_KEY_ID is a rollout mismatch, not a forgery: the key
    // itself proved the contents. It is surfaced for diagnostics rather than
    // rejected, since rejecting would break every client during a rotation.
    final ok = await verifier.verify(signedPayload(bundle), bundle.signature);
    if (!ok) {
      throw const BundleVerificationException(
        'The server configuration failed its signature check and was rejected.',
      );
    }
    if (AppConfig.expectedSigningKeyId.isNotEmpty && bundle.keyId != AppConfig.expectedSigningKeyId) {
      debugPrint(
        '[strict-proxy] bundle keyId ${bundle.keyId} differs from the configured '
        '${AppConfig.expectedSigningKeyId}; verified with the configured key.',
      );
    }
    return bundle;
  }
}

/// Provided so tests and the connection flow share one loader.
final configBundleLoaderProvider = Provider<ConfigBundleLoader>(
  (ref) => ConfigBundleLoader(api: ref.watch(apiProvider)),
);
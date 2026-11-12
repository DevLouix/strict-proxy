import 'dart:convert';

/// Runtime configuration for the client.
///
/// Values are supplied with Flutter build-time defines, for example:
///
///   flutter run \
///     --dart-define=STRICT_ENV=development \
///     --dart-define=STRICT_CONTROLLER_URL=https://controller.example.com
///
/// Never put credentials in a dart-define: client binaries are inspectable.
class AppConfig {
  static const environment = String.fromEnvironment(
    'STRICT_ENV',
    defaultValue: 'development',
  );

  static const _controllerUrl = String.fromEnvironment(
    'STRICT_CONTROLLER_URL',
    defaultValue: 'http://10.0.2.2:8080', // Android emulator -> host loopback
  );

  static const requestTimeoutSeconds = int.fromEnvironment(
    'STRICT_REQUEST_TIMEOUT_SECONDS',
    defaultValue: 15,
  );

  /// IPv4 address assigned to the client TUN interface.
  static const tunIpv4Address = String.fromEnvironment(
    'STRICT_TUN_IPV4_ADDRESS',
    defaultValue: '172.19.0.1/30',
  );

  /// IPv6 address assigned to the client TUN interface.
  static const tunIpv6Address = String.fromEnvironment(
    'STRICT_TUN_IPV6_ADDRESS',
    defaultValue: 'fdfe:dcba:9876::1/126',
  );

  /// GitHub repository used as the fallback update source.
  ///
  /// The controller feed is the normal path. This exists because a build can be
  /// released (the APK is attached to a GitHub release) while nothing is
  /// published to the feed — the publish step needs admin credentials the CI
  /// token cannot create. Empty disables the fallback entirely.
  static const updateFallbackRepo = String.fromEnvironment(
    'STRICT_UPDATE_FALLBACK_REPO',
    defaultValue: 'DevLouix/strict-proxy',
  );

  static bool get isProduction => environment == 'production';

  static String get controllerUrl {
    final uri = Uri.tryParse(_controllerUrl);
    if (uri == null || !uri.hasScheme || uri.host.isEmpty) {
      throw StateError('STRICT_CONTROLLER_URL must be an absolute HTTP(S) URL');
    }
    if (isProduction && uri.scheme != 'https') {
      throw StateError('STRICT_CONTROLLER_URL must use HTTPS in production');
    }
    return _controllerUrl.replaceFirst(RegExp(r'/$'), '');
  }

  static Duration get requestTimeout =>
      Duration(seconds: requestTimeoutSeconds.clamp(1, 120).toInt());

  /// Opaque, installation-scoped device id seed. Combined with a random UUID
  /// at first launch; persisted thereafter (see DeviceIdentity).
  static const deviceNamePrefix = 'StrictProxy Device';

  /// Base64 of the controller's Ed25519 **public** key, used to verify config
  /// bundles. Never the private key.
  ///
  /// Leave empty to disable verification (development). In production a bundle
  /// cannot be used without it: [requireBundleSignature] turns an empty key into
  /// a hard failure rather than a silent downgrade.
  static const _signingPublicKey = String.fromEnvironment('STRICT_SIGNING_PUBLIC_KEY');

  static String get signingPublicKeyBase64 => _signingPublicKey.trim();

  /// Whether the build is configured to verify bundles.
  static bool get hasSigningPublicKey => signingPublicKeyBase64.isNotEmpty;

  /// In production, an unconfigured key is a build error, not a downgrade.
  static bool get requireBundleSignature => isProduction;

  /// The key id the controller signs with, so a rotated key can be recognised.
  static const expectedSigningKeyId = String.fromEnvironment('STRICT_SIGNING_KEY_ID');

  /// Raw 32-byte Ed25519 public key decoded from [signingPublicKeyBase64].
  ///
  /// Throws if the key is configured but malformed, so a bad build define is a
  /// loud failure at first use rather than silent non-verification.
  static List<int> get signingPublicKeyBytes {
    final encoded = signingPublicKeyBase64;
    if (encoded.isEmpty) return const <int>[];
    try {
      return base64Decode(encoded);
    } on FormatException catch (e) {
      throw StateError('STRICT_SIGNING_PUBLIC_KEY is not valid base64: $e');
    }
  }
}

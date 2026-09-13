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
}

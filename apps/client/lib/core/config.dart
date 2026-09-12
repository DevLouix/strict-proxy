/// Runtime configuration for the client.
///
/// The controller URL is injected at build time via `--dart-define`, e.g.:
///   flutter run --dart-define=STRICT_CONTROLLER_URL=https://controller.example.com
class AppConfig {
  static const String controllerUrl = String.fromEnvironment(
    'STRICT_CONTROLLER_URL',
    defaultValue: 'http://10.0.2.2:8080', // Android emulator -> host loopback
  );

  /// Opaque, installation-scoped device id seed. Combined with a random UUID
  /// at first launch; persisted thereafter (see DeviceIdentity).
  static const String deviceNamePrefix = 'StrictProxy Device';
}

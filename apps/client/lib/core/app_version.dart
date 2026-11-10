/// The build identity baked into this APK.
///
/// The release tooling passes these as dart-defines, so the app can compare
/// itself with the version the controller publishes without reading the package
/// manager at runtime. Keep the defaults in step with `pubspec.yaml`; both are
/// overridden by `--build-name` / `--build-number` on a release build.
class AppVersion {
  static const name = String.fromEnvironment('APP_VERSION', defaultValue: '0.1.0');

  static const buildNumber = int.fromEnvironment('APP_BUILD_NUMBER', defaultValue: 1);
}

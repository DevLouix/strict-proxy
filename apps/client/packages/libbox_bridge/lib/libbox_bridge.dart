import 'package:flutter/services.dart';

/// Public channel constants for the native libbox implementation.
///
/// The platform plugin is registered automatically by Flutter. This helper is
/// intentionally small because the application-facing engine owns state and
/// error translation.
class LibboxBridge {
  static const channel = MethodChannel('strict_proxy/libbox');

  static Future<bool> isAvailable() async {
    return await channel.invokeMethod<bool>('isAvailable') ?? false;
  }
}

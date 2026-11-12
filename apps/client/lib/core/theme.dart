import 'package:flutter/material.dart';

/// Status colours shared by the connect button, the plan strip, the subscription
/// chip and the server dots.
///
/// Each surface used to name its own shade (`greenAccent` here, `0xFF4ADE80`
/// there), so the same "connected" state could look different on two screens.
abstract final class StatusColors {
  static const connected = Color(0xFF4ADE80);
  static const pending = Color(0xFFFBBF24);
  static const failed = Color(0xFFF87171);
  static const idle = Color(0xFF6B7280);
}

/// 100% custom branding — no default blue.
ThemeData buildTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: const Color(0xFF7C4DFF), // custom violet
    brightness: Brightness.dark,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: const Color(0xFF0E0E12),
    appBarTheme: const AppBarTheme(
      backgroundColor: Color(0xFF0E0E12),
      surfaceTintColor: Colors.transparent,
      elevation: 0,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: scheme.primary,
        foregroundColor: Colors.white,
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: const Color(0xFF1A1A22),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide.none,
      ),
    ),
  );
}

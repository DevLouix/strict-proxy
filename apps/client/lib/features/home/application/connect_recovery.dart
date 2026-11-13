import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/crash_reporter.dart';

/// Remembers that a tunnel start was in flight, so the next launch can tell a
/// crash during connect from an ordinary failure.
///
/// A native abort inside the engine takes the process down before Dart sees
/// anything: no exception, no error state, nothing on screen. The marker
/// written here is the only evidence left behind, and it is what stops the app
/// from repeating the same failing attempt with the same settings forever.
class ConnectRecovery {
  ConnectRecovery({Future<Map<String, Object?>?> Function()? lastExit})
      : _lastExit = lastExit ?? CrashReporter.lastExit;

  static const _kAttemptAt = 'vpn.attemptAt';
  static const _kCompat = 'vpn.compat';

  /// How long after the attempt an exit Android recorded still belongs to it.
  /// The system writes the exit immediately; this only has to cover the process
  /// dying and the next launch reading it.
  static const crashWindow = Duration(minutes: 2);

  /// The marker is written just before the engine starts, so an exit that
  /// predates it by more than this belongs to an earlier launch.
  static const _clockSkew = Duration(seconds: 5);

  final Future<Map<String, Object?>?> Function() _lastExit;

  Future<SharedPreferences> get _prefs => SharedPreferences.getInstance();

  /// Whether the conservative tunnel settings are in use.
  Future<bool> compatEnabled() async => (await _prefs).getBool(_kCompat) ?? false;

  /// Marks the attempt as in flight. Call immediately before starting the
  /// engine: after that point a crash leaves no chance to record anything.
  Future<void> beginAttempt() async =>
      (await _prefs).setInt(_kAttemptAt, DateTime.now().millisecondsSinceEpoch);

  /// The attempt produced an outcome the app could report, so a later crash is
  /// not this attempt's.
  Future<void> endAttempt() async => (await _prefs).remove(_kAttemptAt);

  /// Enables compat mode when an attempt was left in flight and Android
  /// recorded a crash for that launch. Returns whether compat is now on.
  Future<bool> resolveAfterUncleanExit() async {
    final prefs = await _prefs;
    final startedAt = prefs.getInt(_kAttemptAt);
    if (startedAt == null) return prefs.getBool(_kCompat) ?? false;
    final exit = await _lastExit();
    await prefs.remove(_kAttemptAt);
    if (!shouldEnableCompat(startedAt: startedAt, exit: exit)) {
      return prefs.getBool(_kCompat) ?? false;
    }
    await prefs.setBool(_kCompat, true);
    return true;
  }

  /// Returns to the normal tunnel settings at the user's request.
  Future<void> clearCompat() async => (await _prefs).remove(_kCompat);

  /// Called when the engine died while the app itself is still running.
  ///
  /// The engine has its own process now, so its death is survivable — and
  /// Android records the exit immediately, so the reason can be read without
  /// waiting for the next launch. Returns true if compat mode was switched on.
  Future<bool> noteEngineCrash() async {
    if (await compatEnabled()) return false;
    final exit = await _lastExit();
    if (!shouldEnableCompatAfterEngineDeath(exit)) return false;
    await (await _prefs).setBool(_kCompat, true);
    return true;
  }

  /// True when [exit] is a crash recorded within the last couple of minutes,
  /// i.e. the engine process that just vanished.
  @visibleForTesting
  static bool shouldEnableCompatAfterEngineDeath(
    Map<String, Object?>? exit, {
    DateTime? now,
  }) {
    if (exit == null) return false;
    final exitedAt = (exit['timestamp'] as num?)?.toInt() ?? 0;
    if (exitedAt <= 0) return false;
    final current = now ?? DateTime.now();
    final at = DateTime.fromMillisecondsSinceEpoch(exitedAt);
    if (at.isAfter(current.add(_clockSkew))) return false;
    if (current.difference(at) > crashWindow) return false;
    return _isCrashReason(exit['reason'] as String?);
  }

  static bool _isCrashReason(String? reason) => switch (reason) {
        'crash_native' || 'crash' || 'anr' => true,
        _ => false,
      };

  /// True when [exit] is a crash that happened during the attempt that began at
  /// [startedAt] (milliseconds since epoch).
  ///
  /// [exit] is what Android's `ApplicationExitInfo` recorded for the previous
  /// launch, mapped by the host to `reason`/`timestamp`.
  @visibleForTesting
  static bool shouldEnableCompat({
    required int startedAt,
    required Map<String, Object?>? exit,
    DateTime? now,
  }) {
    if (exit == null) return false;
    final exitedAt = (exit['timestamp'] as num?)?.toInt() ?? 0;
    if (exitedAt <= 0) return false;
    final attemptedAt = DateTime.fromMillisecondsSinceEpoch(startedAt);
    final exitAt = DateTime.fromMillisecondsSinceEpoch(exitedAt);
    final current = now ?? DateTime.now();
    if (exitAt.isBefore(attemptedAt.subtract(_clockSkew))) return false;
    if (current.difference(exitAt) > crashWindow) return false;
    // A low-memory kill says nothing about the tunnel settings, and treating it
    // as one would downgrade the datapath permanently for no reason.
    return _isCrashReason(exit['reason'] as String?);
  }
}

/// Whether the app is on the conservative tunnel settings.
final compatModeProvider = StateProvider<bool>((ref) => false);

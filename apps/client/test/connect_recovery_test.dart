// A native abort during connect is invisible to Dart: the process is gone
// before an error handler runs. These pin the one signal the next launch can
// recover from, and the exits that must not be mistaken for it.
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:strict_proxy_client/features/home/application/connect_recovery.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final attemptedAt = DateTime.utc(2026, 11, 13, 12);
  int ms(DateTime at) => at.millisecondsSinceEpoch;

  Map<String, Object?> exit(String reason, DateTime at) =>
      {'reason': reason, 'timestamp': ms(at)};

  test('a native crash during the attempt enables the safe settings', () {
    expect(
      ConnectRecovery.shouldEnableCompat(
        startedAt: ms(attemptedAt),
        exit: exit('crash_native', attemptedAt.add(const Duration(seconds: 4))),
        now: attemptedAt.add(const Duration(seconds: 40)),
      ),
      isTrue,
    );
  });

  test('a Dart crash and an ANR count too', () {
    for (final reason in ['crash', 'anr']) {
      expect(
        ConnectRecovery.shouldEnableCompat(
          startedAt: ms(attemptedAt),
          exit: exit(reason, attemptedAt.add(const Duration(seconds: 2))),
          now: attemptedAt.add(const Duration(seconds: 20)),
        ),
        isTrue,
        reason: reason,
      );
    }
  });

  test('a low-memory kill does not downgrade the tunnel', () {
    expect(
      ConnectRecovery.shouldEnableCompat(
        startedAt: ms(attemptedAt),
        exit: exit('low_memory', attemptedAt.add(const Duration(seconds: 2))),
        now: attemptedAt.add(const Duration(seconds: 20)),
      ),
      isFalse,
    );
  });

  test('an exit recorded before the attempt belongs to an earlier launch', () {
    expect(
      ConnectRecovery.shouldEnableCompat(
        startedAt: ms(attemptedAt),
        exit: exit('crash_native', attemptedAt.subtract(const Duration(minutes: 1))),
        now: attemptedAt.add(const Duration(seconds: 5)),
      ),
      isFalse,
    );
  });

  test('an exit older than the window is not attributed to this attempt', () {
    expect(
      ConnectRecovery.shouldEnableCompat(
        startedAt: ms(attemptedAt),
        exit: exit('crash_native', attemptedAt.add(const Duration(seconds: 5))),
        now: attemptedAt.add(const Duration(minutes: 10)),
      ),
      isFalse,
    );
  });

  test('no recorded exit means nothing to recover from', () {
    expect(
      ConnectRecovery.shouldEnableCompat(startedAt: ms(attemptedAt), exit: null),
      isFalse,
    );
  });

  test('the marker turns into a sticky setting and is consumed once', () async {
    SharedPreferences.setMockInitialValues({});
    final recovery = ConnectRecovery(
      lastExit: () async => {
        'reason': 'crash_native',
        'timestamp': DateTime.now().millisecondsSinceEpoch,
      },
    );

    await recovery.beginAttempt();
    expect(await recovery.resolveAfterUncleanExit(), isTrue);
    expect(await recovery.compatEnabled(), isTrue);
    // Resolving again with no marker keeps the setting: the fallback stays on
    // until the user asks for the normal settings back.
    expect(await recovery.resolveAfterUncleanExit(), isTrue);

    await recovery.clearCompat();
    expect(await recovery.compatEnabled(), isFalse);
  });

  // The engine has its own process, so its death can be seen while the app is
  // still running; Android records that exit immediately.
  test('an engine death from a crash is recognised in-session', () {
    expect(
      ConnectRecovery.shouldEnableCompatAfterEngineDeath(
        exit('crash_native', attemptedAt.add(const Duration(seconds: 20))),
        now: attemptedAt.add(const Duration(seconds: 30)),
      ),
      isTrue,
    );
  });

  test('a stale or non-crash exit is not an engine death', () {
    expect(
      ConnectRecovery.shouldEnableCompatAfterEngineDeath(
        exit('crash_native', attemptedAt.subtract(const Duration(minutes: 10))),
        now: attemptedAt,
      ),
      isFalse,
      reason: 'an old crash from a previous launch is not this attempt',
    );
    expect(
      ConnectRecovery.shouldEnableCompatAfterEngineDeath(
        exit('low_memory', attemptedAt.add(const Duration(seconds: 5))),
        now: attemptedAt.add(const Duration(seconds: 20)),
      ),
      isFalse,
    );
    expect(ConnectRecovery.shouldEnableCompatAfterEngineDeath(null), isFalse);
  });

  test('an in-session engine crash switches the settings on once', () async {
    SharedPreferences.setMockInitialValues({});
    final recovery = ConnectRecovery(
      lastExit: () async => {
        'reason': 'crash_native',
        'timestamp': DateTime.now().millisecondsSinceEpoch,
      },
    );

    expect(await recovery.noteEngineCrash(), isTrue);
    expect(await recovery.compatEnabled(), isTrue);
    expect(await recovery.noteEngineCrash(), isFalse, reason: 'already on');
  });

  test('an attempt that ended normally never triggers the fallback', () async {
    SharedPreferences.setMockInitialValues({});
    var asked = false;
    final recovery = ConnectRecovery(
      lastExit: () async {
        asked = true;
        return {
          'reason': 'crash_native',
          'timestamp': DateTime.now().millisecondsSinceEpoch,
        };
      },
    );

    await recovery.beginAttempt();
    await recovery.endAttempt();

    expect(await recovery.resolveAfterUncleanExit(), isFalse);
    expect(asked, isFalse, reason: 'no marker means no exit to attribute');
  });
}

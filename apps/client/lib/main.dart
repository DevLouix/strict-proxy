import 'dart:async';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/crash_reporter.dart';
import 'core/theme.dart';
import 'features/auth/presentation/auth_controller.dart';
import 'features/app_shell.dart';
import 'features/home/application/connection_controller.dart';

void main() {
  // Every uncaught error is reported before the app goes down, so a crash that
  // happens on the home screen reaches the operator instead of only the device.
  runZonedGuarded(
    () {
      WidgetsFlutterBinding.ensureInitialized();
      CrashReporter.install();
      PlatformDispatcher.instance.onError = (error, stack) {
        unawaited(CrashReporter.report(error.toString(), stack, fatal: true));
        // Handled: the process keeps running where it can.
        return true;
      };
      runApp(const ProviderScope(child: StrictProxyApp()));
    },
    (error, stack) =>
        unawaited(CrashReporter.report(error.toString(), stack, fatal: true)),
  );
}

class StrictProxyApp extends ConsumerWidget {
  const StrictProxyApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen(authStateProvider, (prev, next) {
      final signedOut = prev?.status == AuthStatus.authenticated &&
          next.status == AuthStatus.unauthenticated;
      if (signedOut) {
        // The session ended, whether the user asked to sign out or the refresh
        // token stopped working. Leaving the engine up would keep routing
        // traffic for an account that is no longer signed in.
        unawaited(ref.read(connectionStateProvider.notifier).disconnect());
      }
    });
    return MaterialApp(
      title: 'StrictProxy',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      home: const RootGate(),
      // Without this every `pushNamed` throws "Could not find a generator for
      // route": the account screen, the server picker and the password-reset
      // link were all unreachable from the home screen.
      onGenerateRoute: onGenerateRoute,
      onUnknownRoute: (settings) =>
          MaterialPageRoute(builder: (_) => const RootGate()),
    );
  }
}

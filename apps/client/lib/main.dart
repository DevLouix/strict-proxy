import 'dart:async';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/crash_reporter.dart';
import 'core/theme.dart';
import 'features/auth/presentation/auth_controller.dart';
import 'features/app_shell.dart';

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
      // Hook for global session-expiry handling.
    });
    return MaterialApp(
      title: 'StrictProxy',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      home: const RootGate(),
    );
  }
}

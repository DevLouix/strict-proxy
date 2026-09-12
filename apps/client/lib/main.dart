import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/theme.dart';
import 'features/auth/presentation/auth_controller.dart';
import 'features/app_shell.dart';

void main() {
  runApp(const ProviderScope(child: StrictProxyApp()));
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

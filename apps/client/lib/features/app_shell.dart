import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'auth/presentation/auth_controller.dart';
import 'auth/presentation/login_screen.dart';
import 'auth/presentation/password_reset_screen.dart';
import 'home/presentation/home_screen.dart';
import 'servers/presentation/servers_screen.dart';
import 'billing/presentation/account_screen.dart';

class RootGate extends ConsumerWidget {
  const RootGate({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authStateProvider);
    switch (auth.status) {
      case AuthStatus.unknown:
        return const Scaffold(body: Center(child: CircularProgressIndicator()));
      case AuthStatus.unauthenticated:
        return const LoginScreen();
      case AuthStatus.authenticated:
        return const HomeScreen();
    }
  }
}

Route<dynamic>? onGenerateRoute(RouteSettings settings) {
  switch (settings.name) {
    case '/servers':
      return MaterialPageRoute(builder: (_) => const ServersScreen());
    case '/account':
      return MaterialPageRoute(builder: (_) => const AccountScreen());
    case '/reset-password':
      // A reset link can point here; the screen accepts the code pasted in, so
      // no per-platform deep-link parsing is required for it to work.
      return MaterialPageRoute(builder: (_) => const PasswordResetScreen());
    default:
      return null;
  }
}

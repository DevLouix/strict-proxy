import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'auth/presentation/auth_controller.dart';
import 'auth/presentation/login_screen.dart';
import 'auth/presentation/password_reset_screen.dart';
import 'home/presentation/home_screen.dart';
import 'servers/presentation/servers_screen.dart';
import 'links/presentation/links_screen.dart';
import 'billing/presentation/account_screen.dart';
import 'billing/presentation/subscription_gate.dart';

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
        // Signing in is not access: an active paid plan is checked before the
        // home screen and its server picker.
        return const SubscriptionGate(child: HomeScreen());
    }
  }
}

Route<dynamic>? onGenerateRoute(RouteSettings settings) {
  switch (settings.name) {
    case '/servers':
      // A deep link must not skip the entitlement check the home screen has.
      return MaterialPageRoute(builder: (_) => const SubscriptionGate(child: ServersScreen()));
    case '/links':
      // Deliberately not behind [SubscriptionGate]: a free account must see the
      // locked links and the upsell, which is the point of publishing them.
      return MaterialPageRoute(builder: (_) => const LinksScreen());
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

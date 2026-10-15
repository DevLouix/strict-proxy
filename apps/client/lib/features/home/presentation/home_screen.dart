import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/presentation/auth_controller.dart';
import '../../billing/application/billing_controller.dart';
import 'plan_strip.dart';
import '../application/connection_controller.dart';

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final conn = ref.watch(connectionStateProvider);
    final auth = ref.watch(authStateProvider);
    final billing = ref.watch(billingProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('StrictProxy'),
        actions: [
          IconButton(
            tooltip: 'Account',
            icon: const Icon(Icons.person_outline),
            onPressed: () => Navigator.of(context).pushNamed('/account'),
          ),
          IconButton(
            tooltip: 'Sign out',
            icon: const Icon(Icons.logout),
            onPressed: () => ref.read(authStateProvider.notifier).logout(),
          ),
        ],
      ),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            GestureDetector(
              onTap: () => ref.read(connectionStateProvider.notifier).toggle(),
              child: ConnectButton(state: conn),
            ),
            const SizedBox(height: 24),
            Text(
              switch (conn) {
                EngineStateIdle() => 'Disconnected',
                EngineStateConnecting() => 'Connecting…',
                EngineStateConnected(:final node) => 'Connected · ${node.region}',
                EngineStateError(:final message) => 'Error: $message',
              },
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(auth.email ?? '', style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 32),
            FilledButton.tonal(
              onPressed: () => Navigator.of(context).pushNamed('/servers'),
              child: const Text('Choose server'),
            ),
            const SizedBox(height: 20),
            PlanStrip(
              subscription: billing.subscription,
              onTap: () async {
                await Navigator.of(context).pushNamed('/account');
                // Tier and quota can change underneath us (a webhook, or a
                // purchase completed while the app was backgrounded), so
                // refresh on return rather than showing stale numbers.
                await ref.read(billingProvider.notifier).load();
              },
            ),
          ],
        ),
      ),
    );
  }
}

/// Big circular connect button — custom visuals, no default accents.
class ConnectButton extends StatelessWidget {
  const ConnectButton({super.key, required this.state});

  final Object state; // pattern-matched above

  @override
  Widget build(BuildContext context) {
    final color = switch (state) {
      EngineStateConnected() => Colors.greenAccent,
      EngineStateConnecting() => Colors.orangeAccent,
      EngineStateError() => Colors.redAccent,
      _ => Colors.white24,
    };
    return Container(
      width: 180,
      height: 180,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: color, width: 4),
      ),
      alignment: Alignment.center,
      child: const Icon(Icons.power_settings_new, size: 64),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/presentation/auth_controller.dart';
import '../application/connection_controller.dart';

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final conn = ref.watch(connectionStateProvider);
    final auth = ref.watch(authStateProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('StrictProxy'),
        actions: [
          IconButton(
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
              child: ConnectButton(state: conn.state),
            ),
            const SizedBox(height: 24),
            Text(
              switch (conn.state) {
                EngineStateIdle() => 'Disconnected',
                EngineStateConnecting() => 'Connecting…',
                EngineStateConnected() => 'Connected · ${conn.node?.region ?? ''}',
                EngineStateError() => 'Error: ${conn.message}',
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

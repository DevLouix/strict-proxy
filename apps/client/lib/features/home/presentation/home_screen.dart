import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/presentation/auth_controller.dart';
import '../../billing/application/billing_controller.dart';
import '../../updates/update_controller.dart';
import 'plan_strip.dart';
import '../application/connection_controller.dart';

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  @override
  void initState() {
    super.initState();
    // Home is the first screen after sign-in, so this is where a new build is
    // noticed. It runs after the first frame and never blocks the UI.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.read(updateProvider.notifier).check();
    });
  }

  Future<void> _installUpdate() async {
    final message = await ref.read(updateProvider.notifier).downloadAndInstall();
    if (!mounted || message == null) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final conn = ref.watch(connectionStateProvider);
    final auth = ref.watch(authStateProvider);
    final billing = ref.watch(billingProvider);
    final update = ref.watch(updateProvider);

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
            if (update.hasUpdate) ...[
              _UpdateBanner(
                version: update.release!.version,
                progress: update.progress,
                onTap: update.progress == null ? _installUpdate : null,
              ),
              const SizedBox(height: 20),
            ],
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

/// Offers the downloaded build when the controller publishes a newer one.
///
/// Android shows its own install confirmation after the download, so the copy
/// says "update", not "install" — the app replaces itself in place and keeps its
/// data and session.
class _UpdateBanner extends StatelessWidget {
  const _UpdateBanner({required this.version, required this.progress, required this.onTap});

  final String version;
  final double? progress;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 24),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Icon(Icons.system_update_alt, color: theme.colorScheme.primary, size: 20),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Update available · v$version',
                    style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                  ),
                ),
                if (progress == null)
                  TextButton(onPressed: onTap, child: const Text('Update'))
                else
                  Text('${(progress! * 100).round()}%', style: theme.textTheme.bodySmall),
              ],
            ),
            if (progress != null) ...[
              const SizedBox(height: 8),
              ClipRRect(
                borderRadius: BorderRadius.circular(999),
                child: LinearProgressIndicator(value: progress, minHeight: 6),
              ),
            ],
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

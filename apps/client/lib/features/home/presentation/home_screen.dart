import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme.dart';
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
    final theme = Theme.of(context);

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
      // Scrollable so the update banner and plan strip cannot push the connect
      // button off a short screen (a RenderFlex overflow before this).
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
            if (update.hasUpdate) ...[
              _UpdateBanner(
                version: update.release!.version,
                source: update.source,
                progress: update.progress,
                onTap: update.progress == null ? _installUpdate : null,
              ),
              const SizedBox(height: 20),
            ],
            ConnectButton(
              state: conn,
              onTap: () => ref.read(connectionStateProvider.notifier).toggle(),
            ),
            const SizedBox(height: 24),
            Text(
              switch (conn) {
                EngineStateIdle() => 'Disconnected',
                EngineStateConnecting() => 'Connecting…',
                EngineStateConnected(:final node) => 'Connected · ${node.region}',
                EngineStateError() => 'Not connected',
              },
              style: theme.textTheme.titleMedium,
              textAlign: TextAlign.center,
            ),
            if (conn is EngineStateConnecting) ...[
              const SizedBox(height: 4),
              Text(
                'Tap the button again to cancel',
                style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
                textAlign: TextAlign.center,
              ),
            ],
            // The engine's own reason, not just "engine error": the native side
            // sends it with the state event and it is the only actionable text
            // available when a tunnel refuses to start.
            if (conn is EngineStateError) ...[
              const SizedBox(height: 6),
              Text(
                conn.message,
                style: theme.textTheme.bodySmall?.copyWith(color: StatusColors.failed),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 4),
              TextButton.icon(
                onPressed: () =>
                    ref.read(connectionStateProvider.notifier).connect(),
                icon: const Icon(Icons.refresh, size: 16),
                label: const Text('Try again'),
              ),
            ],
            if (auth.email != null) ...[
              const SizedBox(height: 8),
              Text(auth.email!, style: theme.textTheme.bodySmall),
            ],
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
  const _UpdateBanner({
    required this.version,
    required this.source,
    required this.progress,
    required this.onTap,
  });

  final String version;
  final String? source;
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
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Update available · v$version',
                        style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                      ),
                      if (source != null)
                        Text(
                          source == 'github' ? 'from GitHub releases' : 'from the update feed',
                          style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
                        ),
                    ],
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
///
/// It is a real button (ink, semantics, a label that states what the tap does),
/// not a bare gesture detector: while connecting the same tap cancels, so the
/// accessibility label has to say so.
class ConnectButton extends StatelessWidget {
  const ConnectButton({super.key, required this.state, required this.onTap});

  final Object state; // pattern-matched above
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = switch (state) {
      EngineStateConnected() => StatusColors.connected,
      EngineStateConnecting() => StatusColors.pending,
      EngineStateError() => StatusColors.failed,
      _ => StatusColors.idle,
    };
    final label = switch (state) {
      EngineStateConnected() => 'Disconnect',
      EngineStateConnecting() => 'Cancel connection attempt',
      _ => 'Connect',
    };
    return Semantics(
      button: true,
      label: label,
      child: Material(
        color: Colors.transparent,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: Container(
            width: 180,
            height: 180,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: color, width: 4),
            ),
            alignment: Alignment.center,
            child: Icon(Icons.power_settings_new, size: 64, color: color),
          ),
        ),
      ),
    );
  }
}

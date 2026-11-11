import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/presentation/auth_controller.dart';
import '../application/billing_controller.dart';
import 'paywall_screen.dart';

/// Client-side entitlement guard.
///
/// Wraps every surface that exposes servers or the tunnel. While the paid plan
/// is loading it shows a spinner rather than the app; an unverified or unpaid
/// account never reaches the child. The controller still enforces access on
/// `/api/v1/network/config`, so this is the user-facing half of the same rule.
class SubscriptionGate extends ConsumerStatefulWidget {
  const SubscriptionGate({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<SubscriptionGate> createState() => _SubscriptionGateState();
}

class _SubscriptionGateState extends ConsumerState<SubscriptionGate> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // The billing provider outlives a session; drop anything a previous account
    // loaded before deciding access for this one. The gate is rebuilt by
    // RootGate on every sign-in, so this is the per-account boundary.
    ref.read(billingProvider.notifier).reset();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // The entitlement arrives from the provider webhook while the user is in
    // the browser paying; re-read it when they return to the app.
    if (state == AppLifecycleState.resumed) _load();
  }

  void _load() {
    if (!mounted) return;
    if (ref.read(billingProvider).loading) return;
    ref.read(billingProvider.notifier).load();
  }

  @override
  Widget build(BuildContext context) {
    final billing = ref.watch(billingProvider);
    final subscription = billing.subscription;

    if (subscription == null) {
      if (billing.error != null && !billing.loading) {
        return _UnverifiedScreen(onRetry: _load);
      }
      // Do not build the app before the entitlement is known; a paid account
      // sees only this spinner for the length of one request.
      if (!billing.loading) {
        WidgetsBinding.instance.addPostFrameCallback((_) => _load());
      }
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    if (subscription.hasActivePaidPlan) return widget.child;
    return const PaywallScreen();
  }
}

/// Shown when the subscription could not be read at all.
///
/// A guard that silently lets people through on a network error is not a guard;
/// this offers a retry and a way out instead.
class _UnverifiedScreen extends ConsumerWidget {
  const _UnverifiedScreen({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final error = ref.watch(billingProvider).error;
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.cloud_off, size: 42),
                const SizedBox(height: 14),
                Text(
                  'Could not verify your plan',
                  style: theme.textTheme.titleLarge,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                Text(
                  error ?? 'The controller did not answer.',
                  style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 20),
                FilledButton(onPressed: onRetry, child: const Text('Try again')),
                TextButton(
                  onPressed: () => ref.read(authStateProvider.notifier).logout(),
                  child: const Text('Sign out'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

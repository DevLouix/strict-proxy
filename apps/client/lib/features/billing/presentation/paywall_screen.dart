import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/billing_models.dart';
import '../../../core/checkout_launcher.dart';
import '../../auth/presentation/auth_controller.dart';
import '../application/billing_controller.dart';

/// Shown instead of the app when the signed-in account has no active paid plan.
///
/// The controller grants access from provider webhooks, so there is nothing to
/// "confirm" locally: the screen opens the hosted checkout and re-reads the
/// subscription when the user comes back or taps refresh.
class PaywallScreen extends ConsumerStatefulWidget {
  const PaywallScreen({super.key});

  @override
  ConsumerState<PaywallScreen> createState() => _PaywallScreenState();
}

class _PaywallScreenState extends ConsumerState<PaywallScreen> {
  @override
  void initState() {
    super.initState();
    // The gate already loads this in the normal path; this covers a direct
    // route or a state restored without data.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final state = ref.read(billingProvider);
      if (state.subscription == null && !state.loading) {
        ref.read(billingProvider.notifier).load();
      }
    });
  }

  Future<void> _subscribe(String tier) async {
    final notifier = ref.read(billingProvider.notifier);
    final url = await notifier.startCheckout(tier);
    if (!mounted) return;
    if (url == null) {
      final message = ref.read(billingProvider).error ?? 'Could not start checkout.';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
      return;
    }

    final opened = await openCheckoutUrl(url);
    notifier.consumeCheckout();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          opened
              ? 'Finish the payment in your browser, then come back — access unlocks automatically.'
              : 'Open this link to pay: $url',
        ),
        duration: const Duration(seconds: 8),
        action: SnackBarAction(label: 'Check', onPressed: () => notifier.load()),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(billingProvider);
    final subscription = state.subscription;
    final theme = Theme.of(context);
    final plans = <TierPrice>[
      ...?state.catalog?.tiers.where((t) => t.tier == 'standard' || t.tier == 'pro'),
    ]..sort((a, b) {
        // Unpriced tiers sort last: they cannot be compared on price and must
        // not open the list with "Price unavailable".
        if (a.isPriced != b.isPriced) return a.isPriced ? -1 : 1;
        return a.amountMinor.compareTo(b.amountMinor);
      });

    return Scaffold(
      appBar: AppBar(
        title: const Text('Subscription required'),
        actions: [
          IconButton(
            tooltip: 'Check again',
            onPressed: state.loading ? null : () => ref.read(billingProvider.notifier).load(),
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.read(billingProvider.notifier).load(),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 24, 20, 32),
          children: [
            Icon(Icons.lock_outline, size: 44, color: theme.colorScheme.primary),
            const SizedBox(height: 14),
            Text(
              'An active plan is required',
              style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            Text(
              'The app and its server list unlock after a plan is active. '
              'Signing in alone is not enough.',
              style: theme.textTheme.bodyMedium?.copyWith(color: theme.hintColor),
              textAlign: TextAlign.center,
            ),
            if (subscription != null) ...[
              const SizedBox(height: 18),
              _StatusNotice(subscription: subscription),
            ],
            if (state.error != null) ...[
              const SizedBox(height: 12),
              _ErrorNotice(message: state.error!),
            ],
            const SizedBox(height: 24),
            if (state.loading && plans.isEmpty)
              const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()))
            else if (plans.isEmpty)
              _Notice(
                text: state.catalog == null
                    ? 'Plans could not be loaded. Check your connection and refresh.'
                    : 'No paid plans are configured for this deployment yet.',
              )
            else ...[
              Text('Choose a plan', style: theme.textTheme.titleMedium),
              const SizedBox(height: 10),
              for (final plan in plans)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Card(
                    child: ListTile(
                      contentPadding: const EdgeInsets.fromLTRB(16, 6, 12, 6),
                      title: Text(plan.label, style: const TextStyle(fontWeight: FontWeight.w600)),
                      subtitle: Text('${plan.formatted} / month'),
                      trailing: FilledButton(
                        onPressed: state.startingCheckout ? null : () => _subscribe(plan.tier),
                        child: state.startingCheckout
                            ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                            : Text(subscription?.tier == plan.tier ? 'Renew' : 'Choose'),
                      ),
                    ),
                  ),
                ),
            ],
            const SizedBox(height: 8),
            TextButton.icon(
              onPressed: state.loading ? null : () => ref.read(billingProvider.notifier).load(),
              icon: const Icon(Icons.check_circle_outline),
              label: const Text('I have paid — check again'),
            ),
            TextButton(
              onPressed: () => ref.read(authStateProvider.notifier).logout(),
              child: const Text('Sign out'),
            ),
            const SizedBox(height: 12),
            Text(
              'Payments are handled by the provider; the app never sees your card details.',
              style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusNotice extends StatelessWidget {
  const _StatusNotice({required this.subscription});

  final SubscriptionSummary subscription;

  @override
  Widget build(BuildContext context) {
    final text = subscription.status == 'active'
        ? 'Your ${subscription.tier} plan is active but not a paid plan.'
        : 'Your ${subscription.tier} plan is ${subscription.status}.';
    return _Notice(text: text);
  }
}

class _ErrorNotice extends StatelessWidget {
  const _ErrorNotice({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.redAccent.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(message, style: const TextStyle(color: Colors.redAccent)),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.4),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(text, style: theme.textTheme.bodySmall, textAlign: TextAlign.center),
    );
  }
}

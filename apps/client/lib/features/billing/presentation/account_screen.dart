import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/billing_models.dart';
import '../../../core/checkout_launcher.dart';
import '../../../core/theme.dart';
import '../../../core/widgets/password_field.dart';
import '../../auth/presentation/auth_controller.dart';
import '../application/billing_controller.dart';

/// Account and subscription screen: current plan, limits, bandwidth usage and
/// the upgrade path. Entitlement is granted by the provider webhook, so this
/// screen reflects server state rather than assuming a purchase succeeded.
class AccountScreen extends ConsumerStatefulWidget {
  const AccountScreen({super.key});

  @override
  ConsumerState<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends ConsumerState<AccountScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(billingProvider.notifier).load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(billingProvider);
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Account'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: state.loading
                ? null
                : () => ref.read(billingProvider.notifier).load(),
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.read(billingProvider.notifier).load(),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (state.error != null) ...[
              _ErrorBanner(
                message: state.error!,
                onDismiss: () =>
                    ref.read(billingProvider.notifier).clearError(),
              ),
              const SizedBox(height: 12),
            ],
            if (state.loading && !state.hasData)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (!state.hasData)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(child: Text('Could not load your subscription.')),
              )
            else ...[
              _PlanCard(
                subscription: state.subscription!,
                onEnableAutoRenew: () =>
                    ref.read(billingProvider.notifier).enableAutoRenew(),
              ),
              const SizedBox(height: 16),
              if (state.subscription!.hasQuota) ...[
                _UsageCard(subscription: state.subscription!),
                const SizedBox(height: 16),
              ],
              _LimitsCard(subscription: state.subscription!),
              const SizedBox(height: 16),
              if (state.catalog != null && !state.catalog!.isUnconfigured) ...[
                _UpgradeSection(
                  catalog: state.catalog!,
                  currentTier: state.subscription!.tier,
                  busy: state.startingCheckout,
                  onUpgrade: _startCheckout,
                ),
              ] else ...[
                _Notice(
                  text: state.catalog == null
                      ? 'Upgrade options are unavailable right now.'
                      : 'This deployment has no payment gateway configured, so upgrades are disabled.',
                ),
              ],
              if (state.usage != null &&
                  state.usage!.credentials.isNotEmpty) ...[
                const SizedBox(height: 16),
                _PerNodeUsage(usage: state.usage!),
              ],
            ],
            const SizedBox(height: 24),
            Text(
              'Usage is metered per node and counted over a rolling 30-day window.',
              style:
                  theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            _DangerZone(onDelete: _confirmDelete),
          ],
        ),
      ),
    );
  }

  /// Confirms with the account password, because deletion is irreversible and an
  /// unprotected tap (or a stolen access token) must not be enough.
  Future<void> _confirmDelete() async {
    final password = await showDialog<String>(
      context: context,
      builder: (_) => const _DeleteAccountDialog(),
    );
    if (!mounted) return;
    if (password == null) return; // cancelled
    if (password.isEmpty) {
      _showMessage('Enter your password to confirm.');
      return;
    }

    final err =
        await ref.read(authStateProvider.notifier).deleteAccount(password);
    if (!mounted) return;
    if (err != null) {
      _showMessage(err);
      return;
    }
    // The account is gone; return to the root so the login screen shows rather
    // than leaving this route on top of it.
    Navigator.of(context).popUntil((route) => route.isFirst);
  }

  void _showMessage(String message) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _startCheckout(String tier) async {
    final notifier = ref.read(billingProvider.notifier);
    final url = await notifier.startCheckout(tier);
    if (!mounted) return;
    if (url == null) {
      final message =
          ref.read(billingProvider).error ?? 'Could not start checkout.';
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(message)));
      return;
    }

    // The provider hosts the payment page; the entitlement arrives later via
    // webhook, so we refresh rather than assuming success.
    final opened = await openCheckoutUrl(url);
    notifier.consumeCheckout();
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          opened
              ? 'Complete payment on the provider page to activate $tier.'
              : 'Open this link to pay: $url',
        ),
        action:
            SnackBarAction(label: 'Reload', onPressed: () => notifier.load()),
      ),
    );
  }
}

/// Asks for the account password before an irreversible deletion.
///
/// A stateful widget so it owns its [TextEditingController]: creating one in the
/// caller and disposing it as soon as `showDialog` returns tears the controller
/// down while the dialog route is still animating out.
class _DeleteAccountDialog extends StatefulWidget {
  const _DeleteAccountDialog();

  @override
  State<_DeleteAccountDialog> createState() => _DeleteAccountDialogState();
}

class _DeleteAccountDialogState extends State<_DeleteAccountDialog> {
  final _password = TextEditingController();

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Delete account?'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'This permanently deletes your account and ends every session. It cannot be undone.',
          ),
          const SizedBox(height: 16),
          PasswordField(
            controller: _password,
            autofocus: true,
            label: 'Confirm your password',
            onFieldSubmitted: (value) => Navigator.of(context).pop(value),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: Colors.redAccent),
          onPressed: () => Navigator.of(context).pop(_password.text),
          child: const Text('Delete account'),
        ),
      ],
    );
  }
}

/// Destructive account actions, set apart from the billing controls above.
class _DangerZone extends StatelessWidget {
  const _DangerZone({required this.onDelete});
  final Future<void> Function() onDelete;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      color: Colors.redAccent.withValues(alpha: 0.06),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
            child: Text('Delete account', style: theme.textTheme.labelMedium),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text(
              'Removes your account and ends every session immediately.',
              style: theme.textTheme.bodySmall,
            ),
          ),
          Align(
            alignment: Alignment.centerRight,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: OutlinedButton(
                onPressed: () => onDelete(),
                style:
                    OutlinedButton.styleFrom(foregroundColor: Colors.redAccent),
                child: const Text('Delete account'),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PlanCard extends StatelessWidget {
  const _PlanCard(
      {required this.subscription, required this.onEnableAutoRenew});
  final SubscriptionSummary subscription;
  final Future<void> Function() onEnableAutoRenew;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Current plan', style: theme.textTheme.labelMedium),
            const SizedBox(height: 6),
            Row(
              children: [
                Text(
                  subscription.tier.toUpperCase(),
                  style: theme.textTheme.headlineSmall
                      ?.copyWith(fontWeight: FontWeight.bold),
                ),
                const SizedBox(width: 10),
                _StatusChip(status: subscription.status),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              subscription.currentPeriodEnd == null
                  ? 'No active billing period'
                  : 'Renews ${formatDate(subscription.currentPeriodEnd)}',
              style: theme.textTheme.bodySmall,
            ),
            if (subscription.hasActivePaidPlan) ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  Icon(
                    subscription.autoRenew
                        ? Icons.autorenew
                        : Icons.autorenew_outlined,
                    size: 16,
                    color: subscription.autoRenew
                        ? Colors.greenAccent
                        : theme.hintColor,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      subscription.autoRenew
                          ? 'Auto-renew on — billed monthly to your saved card'
                          : 'One-time payment — auto-renew is not enabled',
                      style: theme.textTheme.bodySmall,
                    ),
                  ),
                  if (!subscription.autoRenew)
                    TextButton(
                      onPressed: () => onEnableAutoRenew(),
                      child: const Text('Enable'),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      'active' => StatusColors.connected,
      'expired' => StatusColors.pending,
      'revoked' => StatusColors.failed,
      _ => StatusColors.idle,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(
        border: Border.all(color: color.withValues(alpha: 0.5)),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(status, style: TextStyle(color: color, fontSize: 12)),
    );
  }
}

class _UsageCard extends StatelessWidget {
  const _UsageCard({required this.subscription});
  final SubscriptionSummary subscription;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final quota = subscription.bandwidthQuotaBytes ?? 0;
    final exhausted = subscription.isQuotaExhausted;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Bandwidth this window',
                    style: theme.textTheme.labelMedium),
                Text(
                  exhausted
                      ? 'Quota reached'
                      : '${formatBytes(subscription.bytesRemaining ?? 0)} left',
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: exhausted
                        ? StatusColors.failed
                        : theme.colorScheme.primary,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            ClipRRect(
              borderRadius: BorderRadius.circular(999),
              child: LinearProgressIndicator(
                value: subscription.quotaUsedFraction,
                minHeight: 8,
                backgroundColor: theme.colorScheme.surfaceContainerHighest,
                color: exhausted ? StatusColors.failed : theme.colorScheme.primary,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              '${formatBytes(subscription.bytesUsed)} of ${formatBytes(quota)} used',
              style: theme.textTheme.bodySmall,
            ),
            if (exhausted) ...[
              const SizedBox(height: 10),
              Text(
                'You have used your monthly data allowance. Upgrade to restore access.',
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: StatusColors.failed),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _LimitsCard extends StatelessWidget {
  const _LimitsCard({required this.subscription});
  final SubscriptionSummary subscription;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Column(
        children: [
          _LimitRow(
              label: 'Simultaneous devices',
              value: '${subscription.deviceSeats}'),
          const Divider(height: 1),
          _LimitRow(
              label: 'Server access',
              value: subscription.maxNodes >= 999
                  ? 'All nodes'
                  : '${subscription.maxNodes} nodes'),
          const Divider(height: 1),
          _LimitRow(
            label: 'Monthly data',
            value: subscription.hasQuota
                ? formatBytes(subscription.bandwidthQuotaBytes!)
                : 'Unlimited',
          ),
        ],
      ),
    );
  }
}

class _LimitRow extends StatelessWidget {
  const _LimitRow({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      dense: true,
      title: Text(label),
      trailing:
          Text(value, style: const TextStyle(fontWeight: FontWeight.w600)),
    );
  }
}

class _UpgradeSection extends StatelessWidget {
  const _UpgradeSection({
    required this.catalog,
    required this.currentTier,
    required this.busy,
    required this.onUpgrade,
  });

  final BillingCatalog catalog;
  final String currentTier;
  final bool busy;
  final Future<void> Function(String tier) onUpgrade;

  /// Ranks tiers so the cheapest appears first, with unpriced entries last.
  List<TierPrice> get _ordered {
    final list = [...catalog.tiers]
      ..sort((a, b) {
        if (a.isPriced != b.isPriced) return a.isPriced ? -1 : 1;
        return a.amountMinor.compareTo(b.amountMinor);
      });
    return list;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final options = _ordered.where((t) => t.tier != currentTier).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Plans', style: theme.textTheme.titleMedium),
        const SizedBox(height: 10),
        for (final tier in options)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Card(
              child: ListTile(
                title: Text(tier.label,
                    style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text('${tier.formatted} / month'),
                trailing: FilledButton(
                  onPressed: busy ? null : () => onUpgrade(tier.tier),
                  child: busy
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : Text(currentTier == 'free' ? 'Upgrade' : 'Switch'),
                ),
              ),
            ),
          ),
        if (options.isEmpty)
          _Notice(text: 'You are on the highest available plan.'),
      ],
    );
  }
}

class _PerNodeUsage extends StatelessWidget {
  const _PerNodeUsage({required this.usage});
  final UsageReport usage;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sorted = [...usage.credentials]
      ..sort((a, b) => b.bytesUsed.compareTo(a.bytesUsed));

    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
            child: Text('Usage by node', style: theme.textTheme.labelMedium),
          ),
          for (final c in sorted)
            ListTile(
              dense: true,
              leading: Icon(c.revoked ? Icons.block : Icons.circle,
                  size: 10,
                  color: c.revoked ? Colors.redAccent : Colors.greenAccent),
              title: Text(c.nodeId.isEmpty ? 'Unknown node' : c.nodeId,
                  style: theme.textTheme.bodySmall),
              trailing: Text(formatBytes(c.bytesUsed),
                  style: theme.textTheme.bodySmall),
            ),
        ],
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message, required this.onDismiss});
  final String message;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.redAccent.withValues(alpha: 0.12),
      borderRadius: BorderRadius.circular(10),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
        child: Row(
          children: [
            const Icon(Icons.error_outline, color: Colors.redAccent, size: 18),
            const SizedBox(width: 8),
            Expanded(
                child: Text(message,
                    style: const TextStyle(color: Colors.redAccent))),
            IconButton(
                icon: const Icon(Icons.close, size: 18), onPressed: onDismiss),
          ],
        ),
      ),
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
      child: Text(text, style: theme.textTheme.bodySmall),
    );
  }
}

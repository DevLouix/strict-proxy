import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/app_version.dart';
import '../../../core/billing_models.dart';
import '../../../core/checkout_launcher.dart';
import '../../../core/diagnostics.dart';
import '../../../core/theme.dart';
import '../../../core/widgets/password_field.dart';
import '../../auth/presentation/auth_controller.dart';
import '../../diagnostics/presentation/diagnostics_screen.dart';
import '../../home/application/connection_controller.dart';
import '../../updates/update_controller.dart';
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
  bool _sendingDiagnostics = false;

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
            ],
            _ProfileCard(
              email: ref.watch(authStateProvider).email ?? '',
              onChangeEmail: _changeEmail,
              onChangePassword: _changePassword,
            ),
            const SizedBox(height: 24),
            Text(
              'Your data allowance resets every 30 days.',
              style:
                  theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            _SupportCard(
              sending: _sendingDiagnostics,
              onSend: _sendDiagnostics,
              onOpenDiagnostics: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const DiagnosticsScreen(),
                ),
              ),
            ),
            const SizedBox(height: 16),
            _AppInfoCard(
              update: ref.watch(updateProvider),
              onCheck: _checkForUpdates,
            ),
            const SizedBox(height: 16),
            _DangerZone(onDelete: _confirmDelete),
          ],
        ),
      ),
    );
  }

  /// Sends the build, connection state and last recorded exit in one tap, so a
  /// crash that left no Flutter stack can still be explained by the operator.
  Future<void> _sendDiagnostics() async {
    final conn = ref.read(connectionStateProvider);
    final (engine, message) = switch (conn) {
      EngineStateConnected() => ('connected', null),
      EngineStateConnecting() => ('connecting', null),
      EngineStateError(:final message) => ('error', message),
      _ => ('disconnected', null),
    };
    setState(() => _sendingDiagnostics = true);
    final failure = await Diagnostics.send(engine: engine, engineMessage: message);
    if (!mounted) return;
    setState(() => _sendingDiagnostics = false);
    _showMessage(failure ?? 'Diagnostics sent. Thank you.');
  }

  /// Confirms with the account password, because deletion is irreversible and an
  /// unprotected tap (or a stolen access token) must not be enough.
  /// Answers "which version am I on?" from the version baked into the APK, and
  /// says whether the controller is offering anything newer.
  Future<void> _checkForUpdates() async {
    await ref.read(updateProvider.notifier).check(force: true);
    if (!mounted) return;
    final update = ref.read(updateProvider);
    _showMessage(
      update.error ??
          (update.hasUpdate
              ? 'Version ${update.release!.version} '
                  '(build ${update.release!.buildNumber}) is available.'
              : 'You are on the latest build.'),
    );
  }

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

  Future<void> _changeEmail() async {
    final values = await showDialog<Map<String, String>>(
      context: context,
      builder: (_) => _ChangeEmailDialog(
        currentEmail: ref.read(authStateProvider).email ?? '',
      ),
    );
    if (!mounted || values == null) return;
    final error = await ref.read(authStateProvider.notifier).changeEmail(
          values['email']!,
          values['password']!,
        );
    if (!mounted) return;
    _showMessage(error ?? 'Email updated.');
  }

  Future<void> _changePassword() async {
    final values = await showDialog<List<String>>(
      context: context,
      builder: (_) => const _ChangePasswordDialog(),
    );
    if (!mounted || values == null) return;
    final error = await ref
        .read(authStateProvider.notifier)
        .changePassword(values[0], values[1]);
    if (!mounted) return;
    if (error != null) {
      _showMessage(error);
      return;
    }
    // The server revoked every session, including this one; the root gate now
    // shows sign-in instead of a shell whose requests would all fail.
    Navigator.of(context).popUntil((route) => route.isFirst);
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
                  : subscription.autoRenew
                      ? 'Renews ${formatDate(subscription.currentPeriodEnd)}'
                      // A one-time payment does not renew; saying it does made a
                      // lapsed card look like a scheduled charge.
                      : 'Access until ${formatDate(subscription.currentPeriodEnd)}',
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
                          ? 'Renews automatically each month'
                          : 'This plan does not renew automatically',
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
                Text('Data used',
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
                'You have used your 30-day data allowance. Upgrade to restore access.',
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
          // Seats are how many installs may be signed in, not how many tunnels
          // may run: the proxy session is one per account, so "simultaneous
          // devices" promised something the server does not do.
          _LimitRow(
              label: 'Devices signed in',
              value: '${subscription.deviceSeats}'),
          const Divider(height: 1),
          _LimitRow(
              label: 'Server access',
              value: subscription.maxNodes >= 999
                  ? 'All nodes'
                  : '${subscription.maxNodes} nodes'),
          const Divider(height: 1),
          _LimitRow(
            label: 'Data per 30 days',
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

/// Self-service profile controls. Deleting the account lives in the danger
/// zone below; changing an email or password does not need a support ticket.
class _ProfileCard extends StatelessWidget {
  const _ProfileCard({
    required this.email,
    required this.onChangeEmail,
    required this.onChangePassword,
  });

  final String email;
  final Future<void> Function() onChangeEmail;
  final Future<void> Function() onChangePassword;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
            child: Text('Profile', style: theme.textTheme.labelMedium),
          ),
          ListTile(
            title: const Text('Email'),
            subtitle: Text(email.isEmpty ? 'Loading…' : email),
            trailing: TextButton(
              onPressed: email.isEmpty ? null : () => onChangeEmail(),
              child: const Text('Change'),
            ),
          ),
          const Divider(height: 1),
          ListTile(
            title: const Text('Password'),
            subtitle: const Text('Changing it signs out every device'),
            trailing: TextButton(
              onPressed: () => onChangePassword(),
              child: const Text('Change'),
            ),
          ),
        ],
      ),
    );
  }
}

class _ChangeEmailDialog extends StatefulWidget {
  const _ChangeEmailDialog({required this.currentEmail});
  final String currentEmail;

  @override
  State<_ChangeEmailDialog> createState() => _ChangeEmailDialogState();
}

class _ChangeEmailDialogState extends State<_ChangeEmailDialog> {
  late final _email = TextEditingController(text: widget.currentEmail);
  final _password = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  void _submit() {
    final email = _email.text.trim();
    // The server validates again; this only avoids a round trip for an obvious
    // typo and keeps the error next to the field.
    if (!email.contains('@') || !email.contains('.')) {
      setState(() => _error = 'Enter a valid email address.');
      return;
    }
    if (_password.text.isEmpty) {
      setState(() => _error = 'Enter your password to confirm.');
      return;
    }
    Navigator.of(context)
        .pop({'email': email, 'password': _password.text});
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Change email'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'This address is used to sign in and for password resets.',
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _email,
            keyboardType: TextInputType.emailAddress,
            autofillHints: const [AutofillHints.email],
            autocorrect: false,
            enableSuggestions: false,
            textCapitalization: TextCapitalization.none,
            decoration: const InputDecoration(labelText: 'New email'),
          ),
          const SizedBox(height: 12),
          PasswordField(
            controller: _password,
            label: 'Current password',
            onFieldSubmitted: (_) => _submit(),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(
              _error!,
              style: const TextStyle(color: Colors.redAccent, fontSize: 12),
            ),
          ],
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _submit, child: const Text('Save')),
      ],
    );
  }
}

class _ChangePasswordDialog extends StatefulWidget {
  const _ChangePasswordDialog();

  @override
  State<_ChangePasswordDialog> createState() => _ChangePasswordDialogState();
}

class _ChangePasswordDialogState extends State<_ChangePasswordDialog> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    _confirm.dispose();
    super.dispose();
  }

  void _submit() {
    if (_current.text.isEmpty) {
      setState(() => _error = 'Enter your current password.');
      return;
    }
    if (_next.text.length < 10) {
      setState(() => _error = 'Use at least 10 characters.');
      return;
    }
    if (_next.text != _confirm.text) {
      setState(() => _error = 'The new passwords do not match.');
      return;
    }
    Navigator.of(context).pop([_current.text, _next.text]);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Change password'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          PasswordField(
            controller: _current,
            autofocus: true,
            label: 'Current password',
          ),
          const SizedBox(height: 12),
          PasswordField(controller: _next, label: 'New password'),
          const SizedBox(height: 12),
          PasswordField(controller: _confirm, label: 'Confirm new password'),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(
              _error!,
              style: const TextStyle(color: Colors.redAccent, fontSize: 12),
            ),
          ],
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _submit, child: const Text('Change')),
      ],
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

/// The build identity of the installed APK.
///
/// The version is only knowable from inside the app: the store listing is not
/// the source of truth here, and a sideloaded update can lag the published
/// build. Read from the dart-defines the release build baked in, not from the
/// update feed, which describes what is *available*, not what is installed.
class _AppInfoCard extends StatelessWidget {
  const _AppInfoCard({required this.update, required this.onCheck});

  final UpdateState update;
  final Future<void> Function() onCheck;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final offered = update.hasUpdate ? update.release : null;

    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
            child: Text('App info', style: theme.textTheme.labelMedium),
          ),
          ListTile(
            title: const Text('Installed version'),
            subtitle: Text(
              offered == null
                  ? 'Version ${AppVersion.name} (build ${AppVersion.buildNumber})'
                  : 'Version ${AppVersion.name} (build ${AppVersion.buildNumber})'
                      ' \u00b7 build ${offered.buildNumber} is available',
            ),
            trailing: update.checking
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : TextButton(
                    onPressed: () => onCheck(),
                    child: const Text('Check'),
                  ),
          ),
          if (update.error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
              child: Text(
                'Could not check for updates: ${update.error}',
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: StatusColors.failed),
              ),
            ),
        ],
      ),
    );
  }
}

/// One-tap support: sends what the device knows to the controller.
class _SupportCard extends StatelessWidget {
  const _SupportCard({
    required this.sending,
    required this.onSend,
    required this.onOpenDiagnostics,
  });

  final bool sending;
  final Future<void> Function() onSend;
  final VoidCallback onOpenDiagnostics;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
            child: Text('Support', style: theme.textTheme.labelMedium),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text(
              'Send this build, the connection state and the last crash to the operator.',
              style: theme.textTheme.bodySmall,
            ),
          ),
          Align(
            alignment: Alignment.centerRight,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: OutlinedButton.icon(
                onPressed: sending ? null : () => onSend(),
                icon: sending
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.support_agent, size: 18),
                label: Text(sending ? 'Sending\u2026' : 'Send diagnostics'),
              ),
            ),
          ),
          // Readable without adb: the last recorded engine exit and the tunnel
          // settings it led to.
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: onOpenDiagnostics,
                icon: const Icon(Icons.troubleshoot, size: 18),
                label: const Text('View diagnostics'),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

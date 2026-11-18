import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/api_client.dart';
import '../../../core/link_models.dart';
import '../../../core/theme.dart';
import '../../auth/presentation/auth_controller.dart';

/// Sites the operator has put behind the Gatekeeper.
///
/// Every registered account sees the full list, but a link above the account's
/// plan arrives locked and without a usable URL. That is deliberate: hiding the
/// items would leave a Standard customer with no way to know that upgrading
/// reveals more, which is the one thing this screen is meant to explain.
class LinksScreen extends ConsumerStatefulWidget {
  const LinksScreen({super.key});

  @override
  ConsumerState<LinksScreen> createState() => _LinksScreenState();
}

class _LinksScreenState extends ConsumerState<LinksScreen> {
  LinksCatalog? _catalog;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final catalog = await ref.read(apiProvider).links();
      if (!mounted) return;
      setState(() {
        _catalog = catalog;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = 'Could not load your links: $e';
        _loading = false;
      });
    }
  }

  Future<void> _open(GatedLink link) async {
    final target = link.accessUrl;
    if (link.locked || target == null) return;
    final uri = Uri.tryParse(target);
    if (uri == null) {
      _toast('This link is not a valid address.');
      return;
    }
    final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!opened && mounted) {
      _toast('Nothing on this device could open that link.');
    }
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final catalog = _catalog;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Links'),
        actions: [
          IconButton(
            tooltip: 'Refresh links',
            onPressed: _loading ? null : _load,
            icon: _loading
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _buildBody(catalog),
      ),
    );
  }

  Widget _buildBody(LinksCatalog? catalog) {
    if (_error != null) {
      return ListView(
        children: [
          const SizedBox(height: 80),
          _Notice(message: _error!, onRetry: _load),
        ],
      );
    }
    if (catalog == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (catalog.isEmpty) {
      return ListView(
        children: const [
          SizedBox(height: 80),
          _Notice(
            message: 'No links have been published yet. '
                'New partner sites appear here as they are added.',
          ),
        ],
      );
    }

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (catalog.hasLocked && catalog.upgradeMessage != null)
          _UpgradeCard(
            message: catalog.upgradeMessage!,
            targetTier: catalog.upgradeTier,
            onUpgrade: () => Navigator.of(context).pushNamed('/account'),
          ),
        for (final link in catalog.links) ...[
          _LinkTile(link: link, onOpen: () => _open(link)),
          const SizedBox(height: 10),
        ],
        const SizedBox(height: 8),
        Text(
          'Links are protected sites. They open only while you are signed in '
          'through the StrictProxy network.',
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: Theme.of(context).hintColor),
          textAlign: TextAlign.center,
        ),
      ],
    );
  }
}

/// Explains what the current plan reveals, and which plan reveals more.
class _UpgradeCard extends StatelessWidget {
  const _UpgradeCard({
    required this.message,
    required this.targetTier,
    required this.onUpgrade,
  });

  final String message;
  final String? targetTier;
  final VoidCallback onUpgrade;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.only(bottom: 16),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.lock_open, size: 20, color: theme.colorScheme.primary),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    targetTier == null
                        ? 'More links are available'
                        : 'More links on ${tierLabelFor(targetTier!)}',
                    style: theme.textTheme.titleSmall,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              message,
              style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
            ),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: onUpgrade,
                child: Text(
                  targetTier == null
                      ? 'See plans'
                      : 'Upgrade to ${tierLabelFor(targetTier!)}',
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LinkTile extends StatelessWidget {
  const _LinkTile({required this.link, required this.onOpen});

  final GatedLink link;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final locked = link.locked;
    return Card(
      margin: EdgeInsets.zero,
      child: ListTile(
        leading: Icon(
          locked ? Icons.lock_outline : Icons.public,
          color: locked ? StatusColors.pending : StatusColors.connected,
        ),
        title: Row(
          children: [
            Expanded(
              child: Text(
                link.title,
                style: theme.textTheme.bodyLarge
                    ?.copyWith(fontWeight: FontWeight.w600),
              ),
            ),
            _TierChip(label: link.tierLabel),
          ],
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (link.description != null && link.description!.isNotEmpty) ...[
              const SizedBox(height: 2),
              Text(link.description!, style: theme.textTheme.bodySmall),
            ],
            const SizedBox(height: 4),
            Text(
              locked
                  ? 'Requires the ${link.tierLabel} plan'
                  : Uri.tryParse(link.url)?.host ?? link.url,
              style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
            ),
          ],
        ),
        trailing: locked
            ? const Icon(Icons.chevron_right, color: Colors.transparent)
            : TextButton(onPressed: onOpen, child: const Text('Open')),
        onTap: locked ? null : onOpen,
      ),
    );
  }
}

class _TierChip extends StatelessWidget {
  const _TierChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: theme.colorScheme.primary.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label.toUpperCase(),
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.primary,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.5,
        ),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.message, this.onRetry});

  final String message;
  final Future<void> Function()? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.link_off, size: 42),
            const SizedBox(height: 14),
            Text(
              message,
              style: theme.textTheme.bodyMedium,
              textAlign: TextAlign.center,
            ),
            if (onRetry != null) ...[
              const SizedBox(height: 18),
              FilledButton(onPressed: onRetry, child: const Text('Try again')),
            ],
          ],
        ),
      ),
    );
  }
}

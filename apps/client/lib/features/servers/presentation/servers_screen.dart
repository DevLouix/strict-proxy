import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api_client.dart';
import '../../../core/theme.dart';
import '../../engine/engine_adapter.dart';
import '../../auth/presentation/auth_controller.dart';
import '../../home/application/connection_controller.dart';

class ServersScreen extends ConsumerStatefulWidget {
  const ServersScreen({super.key});

  @override
  ConsumerState<ServersScreen> createState() => _ServersScreenState();
}

class _ServersScreenState extends ConsumerState<ServersScreen> {
  List<ServerNode>? _nodes;

  /// Probe result per node id. `null` (absent) means "not measured yet", and
  /// `-1` means the probe failed: conflating the two made every unreachable
  /// node report "probing…" forever.
  Map<String, int> _latencies = {};
  bool _probing = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _probing = true;
      _error = null;
    });
    try {
      final api = ref.read(apiProvider);
      final json = await api.networkConfig();
      final bundle = ConfigBundle.fromJson(json);
      final notifier = ref.read(connectionStateProvider.notifier);
      final latencies = await notifier.measureLatencies(bundle.nodes);
      if (!mounted) return;
      setState(() {
        _nodes = bundle.nodes;
        _latencies = {
          for (final r in latencies)
            r.nodeId: r.latencyMs ?? -1,
        };
        _probing = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _probing = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = 'Could not load the server list: $e';
        _probing = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final nodes = _nodes ?? const <ServerNode>[];
    return Scaffold(
      appBar: AppBar(
        title: const Text('Servers'),
        actions: [
          IconButton(
            tooltip: 'Probe servers',
            onPressed: _probing ? null : _refresh,
            icon: _probing
                ? const SizedBox(
                    width: 18, height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.refresh),
          ),
        ],
      ),
      body: _error != null
          ? _ServerNotice(
              message: _error!,
              onRetry: _refresh,
            )
          : nodes.isEmpty
              ? _ServerNotice(
                  message: _probing
                      ? 'Loading servers…'
                      : 'No servers are available right now.',
                  onRetry: _probing ? null : _refresh,
                )
              : ListView.separated(
                  itemCount: nodes.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, i) {
                    final n = nodes[i];
                    final latency = _latencies[n.id];
                    return ListTile(
                      leading: _statusDot(n.status),
                      title: Text('${n.label} · ${n.region}'),
                      subtitle: Text(
                        latency == null
                            ? 'Checking…'
                            : latency >= 0
                                ? '$latency ms · ${n.loadScore >= 80 ? 'Busy' : 'Available'}'
                                : 'Unavailable right now',
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () {
                        ref
                            .read(connectionStateProvider.notifier)
                            .connect(node: n);
                        Navigator.of(context).popUntil((r) => r.isFirst);
                      },
                    );
                  },
                ),
    );
  }

  Widget _statusDot(String status) {
    final color = switch (status) {
      'online' => StatusColors.connected,
      'degraded' => StatusColors.pending,
      _ => StatusColors.failed,
    };
    return Container(
      width: 10,
      height: 10,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}

/// A load failure is a state of this screen, not silence: an empty list with no
/// explanation is indistinguishable from a deployment that has no servers.
class _ServerNotice extends StatelessWidget {
  const _ServerNotice({required this.message, this.onRetry});

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
            const Icon(Icons.dns_outlined, size: 42),
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

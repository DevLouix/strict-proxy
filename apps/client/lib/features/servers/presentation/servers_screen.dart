import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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
  Map<String, int?> _latencies = {};
  bool _probing = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _probing = true);
    try {
      final api = ref.read(apiProvider);
      final json = await api.networkConfig();
      final bundle = ConfigBundle.fromJson(json);
      final notifier = ref.read(connectionStateProvider.notifier);
      final latencies = await notifier.measureLatencies(bundle.nodes);
      setState(() {
        _nodes = bundle.nodes;
        _latencies = {for (final r in latencies) r.nodeId: r.latencyMs};
        _probing = false;
      });
    } catch (_) {
      setState(() => _probing = false);
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
            onPressed: _probing ? null : _refresh,
            icon: _probing
                ? const SizedBox(
                    width: 18, height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.refresh),
          ),
        ],
      ),
      body: ListView.separated(
        itemCount: nodes.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, i) {
          final n = nodes[i];
          final latency = _latencies[n.id];
          return ListTile(
            leading: _statusDot(n.status),
            title: Text('${n.region} · ${n.hostname}'),
            subtitle: Text(latency == null
                ? 'probing…'
                : latency >= 0
                    ? '$latency ms · load ${n.loadScore}%'
                    : 'unreachable · load ${n.loadScore}%'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () {
              ref.read(connectionStateProvider.notifier).connect(node: n);
              Navigator.of(context).popUntil((r) => r.isFirst);
            },
          );
        },
      ),
    );
  }

  Widget _statusDot(String status) {
    final color = switch (status) {
      'online' => Colors.greenAccent,
      'degraded' => Colors.orangeAccent,
      _ => Colors.redAccent,
    };
    return Container(
      width: 10,
      height: 10,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}

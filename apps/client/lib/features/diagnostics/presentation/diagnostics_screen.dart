import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/app_version.dart';
import '../../../core/config.dart';
import '../../../core/crash_reporter.dart';
import '../../../core/device_info.dart';
import '../../home/application/connect_recovery.dart';
import '../../home/application/connection_controller.dart';

/// What the device knows about the last engine exit.
///
/// A native abort leaves no Dart stack, so the only way to identify it used to
/// be `adb logcat` on the affected phone. Android records the exit reason
/// against the package; this screen shows that record and the tunnel settings
/// it produced, to the person holding the device.
class DiagnosticsScreen extends ConsumerStatefulWidget {
  const DiagnosticsScreen({super.key});

  @override
  ConsumerState<DiagnosticsScreen> createState() => _DiagnosticsScreenState();
}

class _DiagnosticsScreenState extends ConsumerState<DiagnosticsScreen> {
  Future<void>? _loading;
  Map<String, Object?>? _exit;
  DeviceInfo? _device;

  @override
  void initState() {
    super.initState();
    _loading = _load();
  }

  Future<void> _load() async {
    final exit = await CrashReporter.lastExit();
    final device = await DeviceInfo.load();
    if (!mounted) return;
    setState(() {
      _exit = exit;
      _device = device;
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final conn = ref.watch(connectionStateProvider);
    final compat = ref.watch(compatModeProvider);
    final exit = _exit;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Diagnostics'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: () => setState(() => _loading = _load()),
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: FutureBuilder<void>(
        future: _loading,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Card(
                child: Column(
                  children: [
                    _Fact(label: 'Build', value: '${AppVersion.name} (${AppVersion.buildNumber})'),
                    const Divider(height: 1),
                    _Fact(label: 'Device', value: _device?.label ?? 'unknown device'),
                    const Divider(height: 1),
                    _Fact(
                      label: 'Android',
                      value: _device?.osVersion ?? 'unknown',
                    ),
                    const Divider(height: 1),
                    _Fact(
                      label: 'Architecture',
                      value: _device == null || _device!.abis.isEmpty
                          ? 'unknown'
                          : _device!.abis.first,
                    ),
                    const Divider(height: 1),
                    _Fact(label: 'Controller', value: AppConfig.controllerUrl),
                    const Divider(height: 1),
                    _Fact(label: 'Connection', value: _describe(conn)),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              Text('Tunnel settings', style: theme.textTheme.titleMedium),
              const SizedBox(height: 8),
              Card(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ListTile(
                      title: Text(compat ? 'Compatibility mode' : 'Standard'),
                      subtitle: Text(
                        compat
                            ? 'The engine crashed on this device, so the userspace '
                                'stack and a smaller MTU are in use.'
                            : 'The system network stack with strict routing.',
                      ),
                    ),
                    if (compat)
                      Align(
                        alignment: Alignment.centerRight,
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                          child: TextButton(
                            onPressed: () => ref
                                .read(connectionStateProvider.notifier)
                                .clearCompatMode(),
                            child: const Text('Use normal settings'),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              Text('Last engine exit', style: theme.textTheme.titleMedium),
              const SizedBox(height: 8),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: exit == null
                      ? Text(
                          'No crash recorded since the app was installed. '
                          'Android only keeps a few recent exits.',
                          style: theme.textTheme.bodySmall,
                        )
                      : Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              _reasonLabel(exit['reason'] as String?),
                              style: theme.textTheme.bodyMedium
                                  ?.copyWith(fontWeight: FontWeight.w600),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              _formatTimestamp(exit['timestamp']),
                              style: theme.textTheme.bodySmall,
                            ),
                            if ((exit['description'] as String?)?.trim().isNotEmpty ??
                                false) ...[
                              const SizedBox(height: 8),
                              Text(
                                exit['description']!.toString().trim(),
                                style: theme.textTheme.bodySmall?.copyWith(
                                  fontFamily: 'monospace',
                                  color: theme.hintColor,
                                ),
                              ),
                            ],
                          ],
                        ),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                'Send this from Account → Support if a connection keeps failing.',
                style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
                textAlign: TextAlign.center,
              ),
            ],
          );
        },
      ),
    );
  }

  static String _describe(Object state) => switch (state) {
        EngineStateConnected() => 'connected',
        EngineStateConnecting() => 'connecting',
        EngineStateError(:final message) => 'error: $message',
        _ => 'disconnected',
      };

  static String _reasonLabel(String? reason) => switch (reason) {
        'crash_native' => 'Native crash in the VPN engine',
        'crash' => 'App crash',
        'anr' => 'App stopped responding',
        'low_memory' => 'Killed by the system for low memory',
        _ => reason ?? 'Unknown exit',
      };

  static String _formatTimestamp(Object? raw) {
    final ms = (raw as num?)?.toInt() ?? 0;
    if (ms <= 0) return 'time not recorded';
    final at = DateTime.fromMillisecondsSinceEpoch(ms).toLocal();
    String two(int value) => value.toString().padLeft(2, '0');
    return '${at.year}-${two(at.month)}-${two(at.day)} '
        '${two(at.hour)}:${two(at.minute)}:${two(at.second)}';
  }
}

/// One label/value pair in the device summary.
class _Fact extends StatelessWidget {
  const _Fact({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListTile(
      dense: true,
      title: Text(label, style: theme.textTheme.bodySmall),
      trailing: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 240),
        child: Text(
          value,
          textAlign: TextAlign.right,
          style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace'),
        ),
      ),
    );
  }
}

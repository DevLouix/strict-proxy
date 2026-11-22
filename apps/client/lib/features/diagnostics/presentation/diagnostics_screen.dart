import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart';
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

  /// Recent engine output, or null when this build keeps none.
  String? _log;

  @override
  void initState() {
    super.initState();
    _loading = _load();
  }

  Future<void> _load() async {
    final exit = await CrashReporter.lastExit();
    final device = await DeviceInfo.load();
    // Not every platform build keeps an engine log (the Linux engine does
    // not), so a null answer is shown as "no log", not as an error.
    final log = await ref.read(engineProvider).readLog();
    if (!mounted) return;
    setState(() {
      _exit = exit;
      _device = device;
      _log = log;
    });
  }

  Future<void> _copyLog(String log) async {
    await Clipboard.setData(ClipboardData(text: log));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Tunnel log copied.')),
    );
  }

  Future<void> _clearLog() async {
    final cleared = await ref.read(engineProvider).clearLog();
    if (!mounted) return;
    if (cleared) setState(() => _log = '');
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          cleared ? 'Tunnel log cleared.' : 'This build cannot clear the tunnel log.',
        ),
      ),
    );
  }

  /// The newest lines, oldest first. The buffer is already bounded; this keeps
  /// the card readable when it is full.
  static String _tail(String log, {int lines = 200}) {
    final all = log.split('\n');
    if (all.length <= lines) return log;
    return all.sublist(all.length - lines).join('\n');
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
                            ? 'Compatibility mode is active: userspace gVisor '
                                'stack without strict routing.'
                            : 'Userspace gVisor stack with strict routing.',
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
                            // A low-memory kill is the one exit the tunnel
                            // cannot survive: the engine shares this process,
                            // so Android ending the app for memory ends the
                            // tunnel with it. Saying that is what turns the
                            // reason into something the user can act on.
                            if (exit['reason'] == 'low_memory')
                              Text(
                                'Android ended the app to free memory. The VPN '
                                'engine runs in this process, so the tunnel '
                                'stopped with it. Connect again once the phone '
                                'has some memory free.',
                                style: theme.textTheme.bodySmall
                                    ?.copyWith(color: theme.hintColor),
                              ),
                            // Which process died. The engine shares the app's
                            // process, so a native abort shows up here as
                            // `crash_native` against this package rather than a
                            // separate `:vpn` process.
                            if ((exit['process'] as String?)?.trim().isNotEmpty ?? false)
                              Text(
                                (exit['process'] as String).trim(),
                                style: theme.textTheme.bodySmall
                                    ?.copyWith(fontFamily: 'monospace'),
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
              Text('Tunnel log', style: theme.textTheme.titleMedium),
              const SizedBox(height: 8),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'What the engine reported on this device. Turn the VPN '
                        'on, reproduce the problem, then come back here and copy '
                        'this.',
                        style: theme.textTheme.bodySmall,
                      ),
                      const SizedBox(height: 8),
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxHeight: 320),
                        child: SingleChildScrollView(
                          child: SelectableText(
                            _log == null
                                ? 'This build does not keep a tunnel log.'
                                : _log!.trim().isEmpty
                                    ? 'No engine output recorded yet. Connect once to fill this in.'
                                    : _tail(_log!),
                            style: theme.textTheme.bodySmall?.copyWith(
                              fontFamily: 'monospace',
                              fontSize: 11,
                            ),
                          ),
                        ),
                      ),
                      if (_log != null && _log!.trim().isNotEmpty)
                        Row(
                          mainAxisAlignment: MainAxisAlignment.end,
                          children: [
                            TextButton.icon(
                              onPressed: () => _copyLog(_tail(_log!)),
                              icon: const Icon(Icons.copy, size: 18),
                              label: const Text('Copy'),
                            ),
                            TextButton(
                              onPressed: _clearLog,
                              child: const Text('Clear'),
                            ),
                          ],
                        ),
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

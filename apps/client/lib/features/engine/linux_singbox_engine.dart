import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'engine_adapter.dart';

/// Runs the sing-box CLI directly on Linux desktop.
///
/// Linux does not need a gomobile binding: sing-box owns the TUN interface in
/// its process. The binary must be installed separately and the process needs
/// the privileges required by the configured TUN inbound.
class LinuxSingBoxEngine implements VpnEngine {
  LinuxSingBoxEngine({
    String? executable,
    Future<Process> Function(String, List<String>)? processStarter,
  })  : _executable = executable ??
            Platform.environment['STRICT_SING_BOX_BIN'] ??
            'sing-box',
        _processStarter = processStarter ?? Process.start;

  final String _executable;
  final Future<Process> Function(String, List<String>) _processStarter;
  final _controller = StreamController<EngineState>.broadcast();
  Process? _process;
  File? _configFile;
  EngineState _state = EngineState.disconnected;

  @override
  EngineState get state => _state;

  @override
  Stream<EngineState> get stateStream => _controller.stream;

  @override
  Future<void> initialize() async {
    final result = await Process.run(_executable, const ['version']);
    if (result.exitCode != 0) {
      _setState(EngineState.error);
      throw StateError(
        'sing-box is unavailable: ${result.stderr.toString().trim()}',
      );
    }
    _setState(EngineState.disconnected);
  }

  @override
  Future<void> connect(String singBoxConfigJson) async {
    if (singBoxConfigJson.trim().isEmpty) {
      throw const FormatException('sing-box configuration cannot be empty');
    }
    await disconnect();
    _setState(EngineState.connecting);

    final directory = await Directory.systemTemp.createTemp('strict-proxy-');
    final file = File('${directory.path}/config.json');
    await file.writeAsString(singBoxConfigJson, flush: true);
    _configFile = file;

    try {
      final process = await _processStarter(_executable, ['run', '-c', file.path]);
      _process = process;
      process.stdout.transform(utf8.decoder).listen((_) {});
      process.stderr.transform(utf8.decoder).listen((_) {});
      unawaited(_watchExit(process));
      _setState(EngineState.connected);
    } catch (error) {
      await _cleanupConfig();
      _setState(EngineState.error);
      throw StateError('sing-box failed to start: $error');
    }
  }

  @override
  Future<void> disconnect() async {
    final process = _process;
    if (process == null) {
      if (_state != EngineState.disconnected) _setState(EngineState.disconnected);
      await _cleanupConfig();
      return;
    }
    _setState(EngineState.disconnecting);
    process.kill(ProcessSignal.sigterm);
    await process.exitCode.timeout(
      const Duration(seconds: 3),
      onTimeout: () {
        process.kill(ProcessSignal.sigkill);
        return -1;
      },
    );
    _process = null;
    await _cleanupConfig();
    _setState(EngineState.disconnected);
  }

  Future<void> _watchExit(Process process) async {
    final exitCode = await process.exitCode;
    if (!identical(_process, process)) return;
    _process = null;
    await _cleanupConfig();
    _setState(exitCode == 0 ? EngineState.disconnected : EngineState.error);
  }

  Future<void> _cleanupConfig() async {
    final file = _configFile;
    _configFile = null;
    if (file == null) return;
    try {
      await file.parent.delete(recursive: true);
    } on FileSystemException {
      // Cleanup is best-effort; the process lifecycle remains authoritative.
    }
  }

  void _setState(EngineState value) {
    _state = value;
    if (!_controller.isClosed) _controller.add(value);
  }

  @override
  void dispose() {
    final process = _process;
    if (process != null) process.kill(ProcessSignal.sigterm);
    _controller.close();
  }
}

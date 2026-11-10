import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../../core/api_client.dart';
import '../../core/app_version.dart';
import '../../core/config.dart';

/// One published client build, as described by the controller.
class AppRelease {
  const AppRelease({
    required this.version,
    required this.buildNumber,
    required this.sizeBytes,
    required this.notes,
    required this.downloadPath,
  });

  final String version;
  final int buildNumber;
  final int sizeBytes;
  final String notes;

  /// Controller-relative download path, resolved against [AppConfig.controllerUrl].
  final String downloadPath;

  factory AppRelease.fromJson(Map<String, dynamic> json) => AppRelease(
        version: json['version'] as String? ?? '',
        buildNumber: (json['buildNumber'] as num?)?.toInt() ?? 0,
        sizeBytes: (json['sizeBytes'] as num?)?.toInt() ?? 0,
        notes: json['notes'] as String? ?? '',
        downloadPath: json['url'] as String? ?? '',
      );
}

class UpdateState {
  const UpdateState({
    this.release,
    this.checking = false,
    this.progress,
    this.error,
    this.handedToInstaller = false,
  });

  final AppRelease? release;
  final bool checking;

  /// 0.0–1.0 while the APK downloads, null otherwise.
  final double? progress;
  final String? error;

  /// True once Android's package installer was opened for the new build.
  final bool handedToInstaller;

  bool get hasUpdate => release != null && release!.buildNumber > AppVersion.buildNumber;

  UpdateState copyWith({
    Object? release = _unset,
    Object? checking = _unset,
    Object? progress = _unset,
    Object? error = _unset,
    Object? handedToInstaller = _unset,
  }) =>
      UpdateState(
        release: identical(release, _unset) ? this.release : release as AppRelease?,
        checking: identical(checking, _unset) ? this.checking : checking as bool,
        progress: identical(progress, _unset) ? this.progress : progress as double?,
        error: identical(error, _unset) ? this.error : error as String?,
        handedToInstaller: identical(handedToInstaller, _unset)
            ? this.handedToInstaller
            : handedToInstaller as bool,
      );

  static const _unset = Object();
}

final updateProvider = StateNotifierProvider<UpdateController, UpdateState>((ref) => UpdateController());

/// Checks the controller for a newer APK, downloads it and hands it to the
/// Android package installer.
///
/// Android does not allow a normal app to replace itself silently; the install
/// still needs one confirmation tap unless the device is managed. Everything up
/// to that tap — check, download, launching the installer — happens in-app, and
/// the installed app keeps its data and session.
class UpdateController extends StateNotifier<UpdateState> {
  UpdateController() : super(const UpdateState());

  static const _channel = MethodChannel('strict_proxy/updater');

  bool _checked = false;

  Future<void> check({bool force = false}) async {
    if (state.checking || (_checked && !force)) return;
    _checked = true;
    state = state.copyWith(checking: true, error: null);
    try {
      final res = await http
          .get(Uri.parse('${AppConfig.controllerUrl}/api/v1/app/android'))
          .timeout(AppConfig.requestTimeout);
      if (res.statusCode == 404) {
        state = const UpdateState();
        return;
      }
      if (res.statusCode >= 400) {
        throw ApiException(res.statusCode, 'UPDATE_CHECK_FAILED', 'update check failed');
      }
      final body = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      state = UpdateState(release: AppRelease.fromJson(body));
    } catch (_) {
      // A failed update check must never get in the way of connecting: an
      // unreachable controller simply means "no update known".
      state = const UpdateState();
    }
  }

  /// Downloads the published APK and opens the system installer.
  ///
  /// Returns a message to show the user, or null when the installer was opened.
  Future<String?> downloadAndInstall() async {
    final release = state.release;
    if (release == null || !state.hasUpdate) return 'No update available';

    state = state.copyWith(progress: 0, error: null);
    File? file;
    try {
      final dir = Directory('${await _cacheDir()}/updates');
      await dir.create(recursive: true);
      file = File('${dir.path}/strict-proxy-${release.buildNumber}.apk');

      final uri = Uri.parse(release.downloadPath).isAbsolute
          ? Uri.parse(release.downloadPath)
          : Uri.parse(AppConfig.controllerUrl).resolve(release.downloadPath);
      final client = http.Client();
      try {
        final res = await client.send(http.Request('GET', uri));
        if (res.statusCode >= 400) {
          state = state.copyWith(progress: null);
          return 'Download failed (HTTP ${res.statusCode})';
        }
        final total = res.contentLength ?? release.sizeBytes;
        var received = 0;
        final sink = file.openWrite();
        try {
          await for (final chunk in res.stream) {
            sink.add(chunk);
            received += chunk.length;
            if (total > 0) {
              state = state.copyWith(progress: (received / total).clamp(0.0, 1.0).toDouble());
            }
          }
        } finally {
          await sink.close();
        }
      } finally {
        client.close();
      }

      final opened = await _channel.invokeMethod<bool>('install', {'path': file.path}) ?? false;
      state = state.copyWith(progress: null, handedToInstaller: opened);
      if (!opened) {
        return 'Allow StrictProxy to install apps, then tap update again.';
      }
      return null;
    } catch (error) {
      if (file != null && await file.exists()) {
        try {
          await file.delete();
        } catch (_) {
          // A leftover file in the cache is harmless.
        }
      }
      state = state.copyWith(progress: null, error: '$error');
      return 'Update failed: $error';
    }
  }

  /// The app's cache directory, so the APK sits where the installer can read it.
  Future<String> _cacheDir() async =>
      await _channel.invokeMethod<String>('cacheDir') ?? Directory.systemTemp.path;
}

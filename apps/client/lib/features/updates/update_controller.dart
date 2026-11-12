import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../../core/api_client.dart';
import '../../core/app_version.dart';
import '../../core/config.dart';
import '../../core/device_info.dart';

/// One APK of a published build, for a specific CPU architecture.
class AppArtifact {
  const AppArtifact({
    required this.abi,
    required this.sizeBytes,
    required this.url,
  });

  final String abi;
  final int sizeBytes;

  /// Controller-relative download path, resolved against the controller URL.
  final String url;

  factory AppArtifact.fromJson(Map<String, dynamic> json) => AppArtifact(
        abi: json['abi'] as String? ?? 'universal',
        sizeBytes: (json['sizeBytes'] as num?)?.toInt() ?? 0,
        url: json['url'] as String? ?? '',
      );
}

/// One published client build, as described by the controller.
class AppRelease {
  const AppRelease({
    required this.version,
    required this.buildNumber,
    required this.sizeBytes,
    required this.notes,
    required this.downloadPath,
    required this.artifacts,
  });

  final String version;
  final int buildNumber;
  final int sizeBytes;
  final String notes;

  /// Controller-relative download path, resolved against [AppConfig.controllerUrl].
  final String downloadPath;

  /// APKs published for this build: one per ABI, or a single universal APK.
  final List<AppArtifact> artifacts;

  factory AppRelease.fromJson(Map<String, dynamic> json) {
    final downloadPath = json['url'] as String? ?? '';
    final sizeBytes = (json['sizeBytes'] as num?)?.toInt() ?? 0;
    final rawArtifacts = (json['artifacts'] as List<dynamic>?)
            ?.whereType<Map<String, dynamic>>()
            .map(AppArtifact.fromJson)
            .where((artifact) => artifact.url.isNotEmpty)
            .toList(growable: false) ??
        const <AppArtifact>[];

    return AppRelease(
      version: json['version'] as String? ?? '',
      buildNumber: (json['buildNumber'] as num?)?.toInt() ?? 0,
      sizeBytes: sizeBytes,
      notes: json['notes'] as String? ?? '',
      downloadPath: downloadPath,
      // A controller from before split builds describes one APK and no list;
      // treat it as universal so those deployments keep updating.
      artifacts: rawArtifacts.isNotEmpty
          ? rawArtifacts
          : downloadPath.isEmpty
              ? const <AppArtifact>[]
              : <AppArtifact>[AppArtifact(abi: 'universal', sizeBytes: sizeBytes, url: downloadPath)],
    );
  }

  /// The APK this device should install.
  ///
  /// A split build is several times smaller than a universal one, so an exact
  /// ABI match wins. A universal APK is the fallback, and a release with a
  /// single artifact is unambiguous. Null means the controller published no APK
  /// this CPU can run — installing another ABI's APK would crash on load.
  AppArtifact? artifactFor(List<String> deviceAbis) {
    for (final abi in deviceAbis) {
      for (final artifact in artifacts) {
        if (artifact.abi == abi) return artifact;
      }
    }
    for (final artifact in artifacts) {
      if (artifact.abi == 'universal') return artifact;
    }
    return artifacts.length == 1 ? artifacts.first : null;
  }
}

class UpdateState {
  const UpdateState({
    this.release,
    this.artifact,
    this.checking = false,
    this.progress,
    this.error,
    this.handedToInstaller = false,
  });

  final AppRelease? release;

  /// The artifact chosen for this device, when one was published for it.
  final AppArtifact? artifact;

  final bool checking;

  /// 0.0–1.0 while the APK downloads, null otherwise.
  final double? progress;
  final String? error;

  /// True once Android's package installer was opened for the new build.
  final bool handedToInstaller;

  bool get hasUpdate => release != null && release!.buildNumber > AppVersion.buildNumber;

  UpdateState copyWith({
    Object? release = _unset,
    Object? artifact = _unset,
    Object? checking = _unset,
    Object? progress = _unset,
    Object? error = _unset,
    Object? handedToInstaller = _unset,
  }) =>
      UpdateState(
        release: identical(release, _unset) ? this.release : release as AppRelease?,
        artifact: identical(artifact, _unset) ? this.artifact : artifact as AppArtifact?,
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
        // Nothing published on the controller. A released build still exists, so
        // fall back to the GitHub release rather than leaving the device on the
        // build it shipped with.
        state = await _fromGitHub();
        return;
      }
      if (res.statusCode >= 400) {
        throw ApiException(res.statusCode, 'UPDATE_CHECK_FAILED', 'update check failed');
      }
      final body = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      final release = AppRelease.fromJson(body);
      final device = await DeviceInfo.load();
      state = UpdateState(
        release: release,
        artifact: release.artifactFor(device?.abis ?? const <String>[]),
      );
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

    final artifact = state.artifact;
    if (artifact == null) {
      return 'This update was not built for your device\'s CPU.';
    }

    state = state.copyWith(progress: 0, error: null);
    File? file;
    try {
      final dir = Directory('${await _cacheDir()}/updates');
      await dir.create(recursive: true);
      file = File('${dir.path}/strict-proxy-${release.buildNumber}-${artifact.abi}.apk');

      final uri = Uri.parse(artifact.url).isAbsolute
          ? Uri.parse(artifact.url)
          : Uri.parse(AppConfig.controllerUrl).resolve(artifact.url);
      final client = http.Client();
      try {
        final res = await client.send(http.Request('GET', uri));
        if (res.statusCode >= 400) {
          state = state.copyWith(progress: null);
          return 'Download failed (HTTP ${res.statusCode})';
        }
        final total = res.contentLength ?? artifact.sizeBytes;
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

  /// The newest GitHub release, used when the controller feed has no build.
  ///
  /// Release assets are named `strict-proxy-client-android-<sha>-<abi>.apk` and
  /// the tag carries the build number (`client-43`): enough to decide "newer"
  /// and which APK this CPU can run. The controller remains authoritative —
  /// this only runs when its feed answers 404.
  Future<UpdateState> _fromGitHub() async {
    final repo = AppConfig.updateFallbackRepo.trim();
    if (repo.isEmpty) return const UpdateState();
    try {
      final res = await http
          .get(
            Uri.parse('https://api.github.com/repos/$repo/releases?per_page=10'),
            headers: const {'accept': 'application/vnd.github+json'},
          )
          .timeout(AppConfig.requestTimeout);
      if (res.statusCode >= 400) return const UpdateState();

      final releases = jsonDecode(utf8.decode(res.bodyBytes)) as List<dynamic>;
      final device = await DeviceInfo.load();
      for (final raw in releases.whereType<Map<String, dynamic>>()) {
        if (raw['draft'] == true) continue;
        final tag = raw['tag_name'] as String? ?? '';
        final build = int.tryParse(RegExp(r'(\d+)$').firstMatch(tag)?.group(1) ?? '') ?? 0;
        if (build <= 0) continue;

        final artifacts = (raw['assets'] as List<dynamic>? ?? const <dynamic>[])
            .whereType<Map<String, dynamic>>()
            .map(_githubArtifact)
            .whereType<AppArtifact>()
            .toList(growable: false);
        if (artifacts.isEmpty) continue;

        final name = (raw['name'] as String? ?? '').trim();
        final release = AppRelease(
          version: name.isEmpty ? tag : name,
          buildNumber: build,
          sizeBytes: artifacts.fold<int>(0, (max, artifact) => artifact.sizeBytes > max ? artifact.sizeBytes : max),
          notes: (raw['body'] as String? ?? '').trim(),
          downloadPath: artifacts.length == 1 ? artifacts.first.url : '',
          artifacts: artifacts,
        );
        return UpdateState(
          release: release,
          artifact: release.artifactFor(device?.abis ?? const <String>[]),
        );
      }
    } catch (_) {
      // An unreachable GitHub is the same as "no update known".
    }
    return const UpdateState();
  }

  /// One APK from a GitHub release, or null for assets that are not one.
  AppArtifact? _githubArtifact(Map<String, dynamic> asset) {
    final name = asset['name'] as String? ?? '';
    final url = asset['browser_download_url'] as String? ?? '';
    if (!name.endsWith('.apk') || url.isEmpty) return null;
    final abi = RegExp(r'-(arm64-v8a|armeabi-v7a|x86_64|universal)\.apk$').firstMatch(name)?.group(1);
    if (abi == null) return null;
    return AppArtifact(
      abi: abi,
      sizeBytes: (asset['size'] as num?)?.toInt() ?? 0,
      url: url,
    );
  }

  /// The app's cache directory, so the APK sits where the installer can read it.
  Future<String> _cacheDir() async =>
      await _channel.invokeMethod<String>('cacheDir') ?? Directory.systemTemp.path;
}

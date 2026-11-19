import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../../core/api_client.dart';
import '../../core/app_version.dart';
import '../../core/config.dart';
import '../../core/device_info.dart';
import 'apk_cache.dart';

/// A download that could not be finished, with a message fit to show the user.
class UpdateDownloadException implements Exception {
  const UpdateDownloadException(this.message);

  final String message;

  @override
  String toString() => message;
}

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
    this.source,
    this.required = false,
    this.requiredMessage,
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

  /// Where the offer came from: `controller` or `github`.
  final String? source;

  /// True when the controller refused this build with
  /// `CLIENT_UPDATE_REQUIRED`, rather than the feed merely offering a newer one.
  final bool required;

  /// The controller's own reason for refusing this build.
  final String? requiredMessage;

  bool get hasUpdate => release != null && release!.buildNumber > AppVersion.buildNumber;

  UpdateState copyWith({
    Object? release = _unset,
    Object? artifact = _unset,
    Object? checking = _unset,
    Object? progress = _unset,
    Object? error = _unset,
    Object? handedToInstaller = _unset,
    Object? source = _unset,
    Object? required = _unset,
    Object? requiredMessage = _unset,
  }) =>
      UpdateState(
        release: identical(release, _unset) ? this.release : release as AppRelease?,
        artifact: identical(artifact, _unset) ? this.artifact : artifact as AppArtifact?,
        checking: identical(checking, _unset) ? this.checking : checking as bool,
        // Callers naturally write `progress: 0`; narrowing a num to double
        // here turned that into a TypeError inside an update tap handler.
        progress: identical(progress, _unset) ? this.progress : (progress as num?)?.toDouble(),
        error: identical(error, _unset) ? this.error : error as String?,
        handedToInstaller: identical(handedToInstaller, _unset)
            ? this.handedToInstaller
            : handedToInstaller as bool,
        source: identical(source, _unset) ? this.source : source as String?,
        required: identical(required, _unset) ? this.required : required as bool,
        requiredMessage: identical(requiredMessage, _unset)
            ? this.requiredMessage
            : requiredMessage as String?,
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

  /// Guards against a second tap starting a second write to the same file.
  bool _downloading = false;

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
        final next = await _fromGitHub();
        state = next.copyWith(required: state.required, requiredMessage: state.requiredMessage);
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
        source: 'controller',
        required: state.required,
        requiredMessage: state.requiredMessage,
      );
    } catch (_) {
      // A failed update check must never get in the way of connecting: an
      // unreachable controller simply means "no update known" — but a refusal
      // that already happened stays on screen.
      state = UpdateState(required: state.required, requiredMessage: state.requiredMessage);
    }
  }

  /// Records that the controller refused this build (`426
  /// CLIENT_UPDATE_REQUIRED`) and looks for the build that can replace it.
  ///
  /// The refusal can arrive before Home's background check has run, and the
  /// update feed itself is not gated, so fetching here is what turns the error
  /// into an install button.
  Future<void> requireUpdate([String? message]) async {
    final text = message?.trim() ?? '';
    state = state.copyWith(
      required: true,
      requiredMessage: text.isEmpty
          ? 'This build of StrictProxy can no longer connect. Update the app to continue.'
          : text,
    );
    await check(force: true);
  }

  /// Downloads the published APK and opens the system installer.
  ///
  /// The APK is kept in the app's cache under its build and ABI, so a second
  /// tap does not pay for the download twice. That matters most on Android
  /// 8+: the first tap sends the user to allow "install unknown apps", and
  /// returning from that screen used to start the ~100 MB download again. Now
  /// a finished file goes straight to the installer and a partial one is
  /// resumed with a range request.
  ///
  /// Returns a message to show the user, or null when the installer was opened.
  Future<String?> downloadAndInstall() async {
    final release = state.release;
    if (release == null || !state.hasUpdate) return 'No update available';

    final artifact = state.artifact;
    if (artifact == null) {
      return 'This update was not built for your device\'s CPU.';
    }
    if (_downloading) return 'The update is already downloading.';

    _downloading = true;
    state = state.copyWith(error: null);
    try {
      final dir = Directory('${await _cacheDir()}/updates');
      await dir.create(recursive: true);
      final file = File('${dir.path}/${apkFileName(release.buildNumber, artifact.abi)}');
      final expected = artifact.sizeBytes;

      // An APK cached for a different build can never be installed now, and
      // each one is ~100 MB; only this update's file is kept.
      await for (final entry in dir.list()) {
        if (entry is File && entry.path != file.path && entry.path.endsWith('.apk')) {
          try {
            await entry.delete();
          } catch (_) {
            // A leftover file in the cache is harmless.
          }
        }
      }

      final cached = await file.exists() ? await file.length() : 0;
      if (!isCompleteDownload(cached, expected)) {
        final offset = resumeOffset(cached, expected);
        if (offset == 0 && cached > 0) await file.delete();
        if (expected > 0) {
          state = state.copyWith(progress: offset / expected);
        }
        final uri = Uri.parse(artifact.url).isAbsolute
            ? Uri.parse(artifact.url)
            : Uri.parse(AppConfig.controllerUrl).resolve(artifact.url);
        await _downloadInto(file, uri, offset: offset, expectedBytes: expected);
      }

      state = state.copyWith(progress: null, error: null);
      final opened = await _channel.invokeMethod<bool>('install', {'path': file.path}) ?? false;
      state = state.copyWith(handedToInstaller: opened);
      if (!opened) {
        return 'Allow StrictProxy to install apps, then tap update again — the download is kept.';
      }
      return null;
    } catch (error) {
      // The file is deliberately left in place: a partial download is exactly
      // what the next tap resumes.
      state = state.copyWith(progress: null, error: '$error');
      return 'Update failed: $error';
    } finally {
      _downloading = false;
    }
  }

  /// Streams [uri] into [file], continuing from [offset] bytes already on disk.
  Future<void> _downloadInto(
    File file,
    Uri uri, {
    required int offset,
    required int expectedBytes,
  }) async {
    final client = http.Client();
    try {
      final request = http.Request('GET', uri);
      if (offset > 0) request.headers['range'] = 'bytes=$offset-';
      final res = await client.send(request);

      if (res.statusCode == 416) {
        // The controller says the APK is not this long, so the cached bytes
        // are not a prefix of it. Throw them away and fetch the whole file.
        await res.stream.drain<void>();
        await file.delete();
        await _downloadInto(file, uri, offset: 0, expectedBytes: expectedBytes);
        return;
      }
      if (res.statusCode >= 400) {
        await res.stream.drain<void>();
        throw UpdateDownloadException('Download failed (HTTP ${res.statusCode})');
      }

      // 206 means the range was honoured and the body continues our file. A
      // 200 means it was ignored and the body starts at byte zero, so the
      // file must be rewritten rather than appended to.
      final resuming = offset > 0 && res.statusCode == 206;
      if (!resuming && await file.exists()) await file.delete();

      var received = resuming ? offset : 0;
      final remaining = res.contentLength;
      final total = remaining != null
          ? received + remaining
          : expectedBytes > 0
              ? expectedBytes
              : 0;

      final sink = file.openWrite(mode: resuming ? FileMode.append : FileMode.write);
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

      final size = await file.length();
      if (expectedBytes > 0 && size < expectedBytes) {
        // Keep the partial file so the next tap continues from here.
        throw UpdateDownloadException(
          'the download stopped at $size of $expectedBytes bytes; tap update to resume',
        );
      }
      if (expectedBytes > 0 && size > expectedBytes) {
        await file.delete();
        throw UpdateDownloadException('the download was longer than the published APK; tap update to try again');
      }
    } finally {
      client.close();
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
          source: 'github',
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

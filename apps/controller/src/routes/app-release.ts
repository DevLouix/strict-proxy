/**
 * Android client distribution, used by the app's in-app updater.
 *
 * Users update from inside the app rather than from a store, so the newest APK
 * is published here: the controller is already the one HTTPS origin the app
 * talks to. An operator drops the signed APK on the server and names it with
 * three env values; while any of them is unset (or the file is missing) the
 * routes answer 404 and clients keep running their current build.
 *
 * Nothing is authenticated: the APK itself is public, and Android only accepts
 * it as an update when it is signed with the same release key.
 */
import { Router } from 'express';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export interface AppReleaseConfig {
  /** Version name published to clients, e.g. `0.2.0`. Empty means none. */
  clientAndroidVersion: string;
  /** Version code; the app compares it with its own build number. */
  clientAndroidBuildNumber: number;
  /** Absolute path to the signed APK on the controller's filesystem. */
  clientAndroidApkPath: string;
  /** Release notes shown next to the update prompt. */
  clientAndroidNotes: string;
}

export function buildAppReleaseRouter({ cfg }: { cfg: AppReleaseConfig }): Router {
  const router = Router();

  /** Resolved APK path, or null when no complete release is published. */
  const publishedApk = (): string | null => {
    if (cfg.clientAndroidVersion.trim() === '' || cfg.clientAndroidBuildNumber <= 0) return null;
    if (cfg.clientAndroidApkPath.trim() === '') return null;
    const resolved = path.resolve(cfg.clientAndroidApkPath);
    return existsSync(resolved) ? resolved : null;
  };

  const unavailable = (res: import('express').Response) =>
    res.status(404).json({ code: 'CLIENT_RELEASE_UNAVAILABLE', error: 'no client update is published' });

  router.get('/api/v1/app/android', (_req, res) => {
    const apk = publishedApk();
    if (!apk) {
      unavailable(res);
      return;
    }
    // Metadata changes whenever the operator swaps the APK, so never cache it.
    res.setHeader('cache-control', 'no-cache');
    res.json({
      version: cfg.clientAndroidVersion,
      buildNumber: cfg.clientAndroidBuildNumber,
      sizeBytes: statSync(apk).size,
      notes: cfg.clientAndroidNotes,
      // Relative on purpose: clients resolve it against the controller URL they
      // were built with, so a proxied or renamed host still works.
      url: '/api/v1/app/android/download',
    });
  });

  router.get('/api/v1/app/android/download', (_req, res, next) => {
    const apk = publishedApk();
    if (!apk) {
      unavailable(res);
      return;
    }
    res.setHeader('content-type', 'application/vnd.android.package-archive');
    res.setHeader(
      'content-disposition',
      `attachment; filename="strict-proxy-${cfg.clientAndroidBuildNumber}.apk"`,
    );
    res.sendFile(apk, (error) => {
      if (error) next(error);
    });
  });

  return router;
}

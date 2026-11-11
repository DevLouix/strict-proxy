/**
 * Android client distribution, used by the app's in-app updater.
 *
 * Users update from inside the app rather than from a store, so the newest APK
 * is published here: the controller is already the one HTTPS origin the app
 * talks to. A build reaches this route only when an administrator publishes it
 * from the dashboard (or, on an older deployment, names it with the
 * `CLIENT_ANDROID_*` environment values); otherwise both routes answer 404 and
 * clients keep running their current build.
 *
 * Nothing is authenticated: the APK itself is public, and Android only accepts
 * it as an update when it is signed with the same release key.
 */
import { Router } from 'express';
import type { Db } from '../db/client.js';
import {
  activeRelease,
  environmentRelease,
  publicRelease,
  selectArtifact,
  type ClientReleaseConfig,
} from '../services/client-apps.js';

export type AppReleaseConfig = ClientReleaseConfig;

export function buildAppReleaseRouter({ cfg, db }: { cfg: AppReleaseConfig; db?: Db }): Router {
  const router = Router();

  /** The published build, or null when none is complete. */
  const published = async () => (db ? activeRelease(db, cfg) : environmentRelease(cfg));

  const unavailable = (res: import('express').Response) =>
    res.status(404).json({ code: 'CLIENT_RELEASE_UNAVAILABLE', error: 'no client update is published' });

  router.get('/api/v1/app/android', (_req, res, next) => {
    void published()
      .then((release) => {
        if (!release) {
          unavailable(res);
          return;
        }
        // Metadata changes whenever a build is published, so never cache it.
        res.setHeader('cache-control', 'no-cache');
        res.json(publicRelease(release));
      })
      .catch(next);
  });

  router.get('/api/v1/app/android/download', (req, res, next) => {
    void (async () => {
      const release = await published();
      if (!release) {
        unavailable(res);
        return;
      }

      const requested = typeof req.query.abi === 'string' ? req.query.abi : null;
      const artifact = selectArtifact(release, requested);
      if (!artifact) {
        res.status(404).json({
          code: 'CLIENT_ABI_UNAVAILABLE',
          error: requested
            ? `no APK was published for ${requested}`
            : 'this release has no APK for this device',
        });
        return;
      }

      res.setHeader('content-type', 'application/vnd.android.package-archive');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader(
        'content-disposition',
        `attachment; filename="strict-proxy-${release.buildNumber}-${artifact.abi}.apk"`,
      );
      res.sendFile(artifact.filePath, (error) => {
        if (error) next(error);
      });
    })().catch(next);
  });

  return router;
}

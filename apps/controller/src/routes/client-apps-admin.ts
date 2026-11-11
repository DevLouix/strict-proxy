/**
 * Admin controls for Android client distribution.
 *
 * The dashboard's Client apps screen is the operator-facing half of this: it
 * uploads one APK per ABI, lists what is stored, and publishes or withdraws a
 * build. Publishing is deliberately separate from uploading, so a half-uploaded
 * build (one ABI out of three) is never offered to users by accident.
 *
 * The upload body is the APK itself, not multipart or base64: a 60–90 MB split
 * APK would grow by a third when encoded, and the browser can stream a File
 * straight through. The body parser is scoped to this route and capped well
 * above the largest expected APK.
 */
import express, { Router, type Request, type Response } from 'express';
import { desc } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import { clientCrashReports } from '../db/schema.js';
import { asyncHandler, requireAdmin, requireJwt } from '../middleware.js';
import {
  CLIENT_ABIS,
  activeRelease,
  deleteRelease,
  isClientAbi,
  listReleases,
  setReleaseStatus,
  upsertArtifact,
  type ClientReleaseStatus,
} from '../services/client-apps.js';

const MAX_NOTES = 2000;
const MAX_VERSION = 40;

function fail(res: Response, status: number, error: string, code: string): void {
  res.status(status).json({ error, code });
}

/** A build number from the path, or null when it is not a positive integer. */
function buildNumberFrom(req: Request): number | null {
  const value = Number.parseInt(String(req.params.buildNumber ?? ''), 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function adminRelease(release: Awaited<ReturnType<typeof activeRelease>>) {
  if (!release) return null;
  return {
    id: release.id,
    version: release.version,
    buildNumber: release.buildNumber,
    notes: release.notes,
    status: release.status,
    source: release.source,
    createdAt: release.createdAt,
    publishedAt: release.publishedAt,
    artifacts: release.artifacts.map((artifact) => ({
      abi: artifact.abi,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
    })),
  };
}

export function buildClientAppsAdminRouter({ db, cfg }: { db: Db; cfg: ControllerConfig }): Router {
  const router = Router();
  const requireAdministrator = [requireJwt(cfg, db), requireAdmin];

  router.get(
    '/api/v1/admin/client-apps/android/releases',
    ...requireAdministrator,
    asyncHandler(async (_req, res) => {
      const [releases, active] = await Promise.all([listReleases(db, cfg), activeRelease(db, cfg)]);
      res.setHeader('cache-control', 'no-store');
      res.json({
        platform: 'android',
        abis: CLIENT_ABIS,
        releases: releases.map((release) => ({
          id: release.id,
          version: release.version,
          buildNumber: release.buildNumber,
          notes: release.notes,
          status: release.status,
          createdAt: release.createdAt,
          publishedAt: release.publishedAt,
          artifacts: release.artifacts.map((artifact) => ({
            abi: artifact.abi,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
          })),
        })),
        activeBuildNumber: active?.buildNumber ?? null,
        activeSource: active?.source ?? null,
        environment: {
          configured:
            cfg.clientAndroidVersion.trim() !== '' &&
            cfg.clientAndroidBuildNumber > 0 &&
            cfg.clientAndroidApkPath.trim() !== '',
          version: cfg.clientAndroidVersion,
          buildNumber: cfg.clientAndroidBuildNumber,
        },
      });
    }),
  );

  router.put(
    '/api/v1/admin/client-apps/android/releases/:buildNumber/artifacts',
    ...requireAdministrator,
    // Scoped body parser: only this route accepts an APK-sized body.
    express.raw({ type: () => true, limit: '400mb' }),
    asyncHandler(async (req, res) => {
      const buildNumber = buildNumberFrom(req);
      if (buildNumber === null) {
        fail(res, 400, 'buildNumber must be a positive integer', 'VALIDATION');
        return;
      }

      const version = String(req.query.version ?? '').trim();
      if (version === '' || version.length > MAX_VERSION) {
        fail(res, 400, `version is required (at most ${MAX_VERSION} characters)`, 'VALIDATION');
        return;
      }
      const notes = String(req.query.notes ?? '').slice(0, MAX_NOTES);
      const abi = String(req.query.abi ?? 'universal').trim();
      if (!isClientAbi(abi)) {
        fail(res, 400, `abi must be one of: ${CLIENT_ABIS.join(', ')}`, 'VALIDATION');
        return;
      }

      const bytes = req.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        fail(res, 400, 'the request body must be the APK bytes', 'VALIDATION');
        return;
      }
      // An APK is a ZIP; refusing anything else keeps a wrong file from being
      // published as an update that Android can never install.
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        fail(res, 400, 'the uploaded file is not an APK (ZIP) archive', 'INVALID_APK');
        return;
      }

      const release = await upsertArtifact(db, cfg, {
        buildNumber,
        version,
        notes,
        abi,
        bytes,
        createdBy: req.auth?.sub ?? null,
      });

      res.status(201).json({
        release: adminRelease(release),
        artifact: {
          abi,
          sizeBytes: bytes.length,
          sha256: release.artifacts.find((artifact) => artifact.abi === abi)?.sha256 ?? null,
        },
      });
    }),
  );

  router.post(
    '/api/v1/admin/client-apps/android/releases/:buildNumber/status',
    ...requireAdministrator,
    asyncHandler(async (req, res) => {
      const buildNumber = buildNumberFrom(req);
      if (buildNumber === null) {
        fail(res, 400, 'buildNumber must be a positive integer', 'VALIDATION');
        return;
      }
      const status = String((req.body as { status?: unknown })?.status ?? '') as ClientReleaseStatus;
      if (!['draft', 'published', 'revoked'].includes(status)) {
        fail(res, 400, 'status must be draft, published or revoked', 'VALIDATION');
        return;
      }
      if (status === 'published') {
        const releases = await listReleases(db, cfg);
        const target = releases.find((release) => release.buildNumber === buildNumber);
        if (!target) {
          fail(res, 404, 'no such release', 'NOT_FOUND');
          return;
        }
        if (target.artifacts.length === 0) {
          fail(res, 400, 'upload at least one APK before publishing this build', 'NO_ARTIFACTS');
          return;
        }
      }
      const updated = await setReleaseStatus(db, buildNumber, status);
      if (!updated) {
        fail(res, 404, 'no such release', 'NOT_FOUND');
        return;
      }
      res.json({ ok: true, buildNumber, status });
    }),
  );

  router.delete(
    '/api/v1/admin/client-apps/android/releases/:buildNumber',
    ...requireAdministrator,
    asyncHandler(async (req, res) => {
      const buildNumber = buildNumberFrom(req);
      if (buildNumber === null) {
        fail(res, 400, 'buildNumber must be a positive integer', 'VALIDATION');
        return;
      }
      const deleted = await deleteRelease(db, cfg, buildNumber);
      if (!deleted) {
        fail(res, 404, 'no such release', 'NOT_FOUND');
        return;
      }
      res.json({ ok: true });
    }),
  );

  router.get(
    '/api/v1/admin/client-apps/android/crashes',
    ...requireAdministrator,
    asyncHandler(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      const rows = await db
        .select()
        .from(clientCrashReports)
        .orderBy(desc(clientCrashReports.createdAt))
        .limit(limit);
      res.setHeader('cache-control', 'no-store');
      res.json({ crashes: rows });
    }),
  );

  return router;
}

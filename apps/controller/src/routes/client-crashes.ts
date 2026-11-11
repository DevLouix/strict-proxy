/**
 * Crash reports from the mobile client.
 *
 * The home-screen crash the user hit left no trace an operator could read: the
 * app died on the device and the controller never heard about it. Clients now
 * post uncaught Flutter and platform errors here, and the dashboard's Client
 * apps screen lists them.
 *
 * This endpoint is unauthenticated on purpose — a crash can happen before the
 * user signs in — so it is treated as hostile input: rate limited per IP, every
 * field truncated, and idempotent on the client-generated `report_id` so a
 * retry does not duplicate a report. It never echoes the report back.
 */
import { Router } from 'express';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import { clientCrashReports } from '../db/schema.js';
import { asyncHandler } from '../middleware.js';
import { rateLimit } from '../services/rate-limit.js';

const MAX_MESSAGE = 4000;
const MAX_STACK = 20000;
const MAX_FIELD = 200;

function text(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, limit);
}

export function buildClientCrashRouter({ db, cfg }: { db: Db; cfg: ControllerConfig }): Router {
  const router = Router();

  router.post(
    '/api/v1/client/crashes',
    rateLimit(cfg, { bucket: 'client.crashes', maxAttempts: 30, windowSeconds: 60 }),
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const message = text(body.message, MAX_MESSAGE);
      if (!message) {
        res.status(400).json({ error: 'message is required', code: 'VALIDATION' });
        return;
      }

      const buildNumber = Number(body.buildNumber);
      const context = body.context;
      await db
        .insert(clientCrashReports)
        .values({
          reportId: text(body.reportId, MAX_FIELD),
          platform: text(body.platform, 32) ?? 'android',
          appVersion: text(body.appVersion, MAX_FIELD),
          buildNumber: Number.isFinite(buildNumber) && buildNumber > 0 ? Math.trunc(buildNumber) : null,
          abi: text(body.abi, MAX_FIELD),
          device: text(body.device, MAX_FIELD),
          osVersion: text(body.osVersion, MAX_FIELD),
          message,
          stack: text(body.stack, MAX_STACK),
          context:
            context !== null && typeof context === 'object' && !Array.isArray(context)
              ? (context as Record<string, unknown>)
              : null,
        })
        // A client retrying a queued report must not create duplicates.
        .onConflictDoNothing();

      // 202: the report is accepted, not necessarily placed on disk yet.
      res.status(202).json({ ok: true });
    }),
  );

  return router;
}

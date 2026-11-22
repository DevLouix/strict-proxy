/**
 * Gatekeeper Key Factory & Site Bootstrap routes.
 *
 * - Admin Key Factory:
 *   GET    /api/v1/admin/gatekeeper/keys
 *   POST   /api/v1/admin/gatekeeper/keys
 *   POST   /api/v1/admin/gatekeeper/keys/:id/rotate
 *   POST   /api/v1/admin/gatekeeper/keys/:id/revoke
 *   DELETE /api/v1/admin/gatekeeper/keys/:id
 *
 * - Site Bootstrap (used by `@strict-proxy/gatekeeper` & `strict-proxy-gatekeeper`
 *   when configured with `apiKey: 'sp_gk_...'`):
 *   GET    /api/v1/gatekeeper/bootstrap
 */
import { createPublicKey } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { inArray } from 'drizzle-orm';
import { loadSigningPrivateKey, signJson } from '@strict-proxy/types';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import { nodes } from '../db/schema.js';
import { asyncHandler, requireJwt } from '../middleware.js';
import { auditActor, recordAudit } from '../services/audit.js';
import {
  createGatekeeperKey,
  deleteGatekeeperKey,
  listGatekeeperKeys,
  normalizeGatekeeperKeyInput,
  revokeGatekeeperKey,
  rotateGatekeeperKey,
  verifyGatekeeperKey,
} from '../services/gatekeeper-keys.js';

interface Ctx {
  db: Db;
  cfg: ControllerConfig;
}

function extractPresentedKey(req: Request): string | undefined {
  const auth = req.header('authorization');
  if (auth && /^bearer\s+/i.test(auth)) {
    const token = auth.replace(/^bearer\s+/i, '').trim();
    if (token) return token;
  }
  const direct = req.header('x-gatekeeper-key') ?? req.header('x-api-key');
  return direct?.trim() || undefined;
}

function requestClientIp(req: Request): string | null {
  const raw = req.ip || req.socket?.remoteAddress || null;
  if (!raw) return null;
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

export function buildGatekeeperKeysRouter(ctx: Ctx): Router {
  const router = Router();

  const adminOnly = [
    requireJwt(ctx.cfg, ctx.db),
    (req: Request, res: Response, next: () => void) => {
      if (req.auth?.role !== 'admin') {
        res.status(403).json({ error: 'administrator access required', code: 'FORBIDDEN' });
        return;
      }
      next();
    },
  ];

  const signingPublicKeyPem = () =>
    createPublicKey(loadSigningPrivateKey(ctx.cfg.signingPrivateKeyPem))
      .export({ type: 'spki', format: 'pem' })
      .toString();

  // -- Site SDK bootstrap (single-line sp_gk_... API key) ---------------------
  router.get(
    '/api/v1/gatekeeper/bootstrap',
    asyncHandler(async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const presented = extractPresentedKey(req);
      const site = await verifyGatekeeperKey(ctx.db, presented, requestClientIp(req));
      if (!site) {
        res.status(401).json({
          error: 'Invalid, revoked, or expired Gatekeeper site key.',
          code: 'GATEKEEPER_KEY_INVALID',
        });
        return;
      }

      const rows = await ctx.db
        .select({ publicIp: nodes.publicIp })
        .from(nodes)
        .where(inArray(nodes.status, ['online', 'degraded']))
        .orderBy(nodes.region, nodes.label, nodes.hostname);

      const generatedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const ips = rows.map((r) => r.publicIp).sort();
      const payload = { generatedAt, expiresAt, ips };
      const signature = signJson(loadSigningPrivateKey(ctx.cfg.signingPrivateKeyPem), payload);

      res.json({
        site,
        keyId: ctx.cfg.signingKeyId,
        algorithm: 'Ed25519',
        publicKeyPem: signingPublicKeyPem(),
        ...payload,
        signature,
      });
    }),
  );

  // -- Admin Key Factory CRUD -------------------------------------------------
  router.get(
    '/api/v1/admin/gatekeeper/keys',
    ...adminOnly,
    asyncHandler(async (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const keys = await listGatekeeperKeys(ctx.db);
      res.json({ keys });
    }),
  );

  router.post(
    '/api/v1/admin/gatekeeper/keys',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      let input;
      try {
        input = normalizeGatekeeperKeyInput(req.body);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message, code: 'VALIDATION_ERROR' });
        return;
      }
      const created = await createGatekeeperKey(ctx.db, input, req.auth?.sub ?? null);
      await recordAudit(ctx.db, {
        ...auditActor(req),
        action: 'gatekeeper_key.created',
        targetType: 'gatekeeper_key',
        targetId: created.key.id,
        summary: `Created Gatekeeper site key "${created.key.name}" (${created.key.keyPrefix})`,
        metadata: { keyPrefix: created.key.keyPrefix, expiresAt: created.key.expiresAt },
      });
      res.status(201).json(created);
    }),
  );

  router.post(
    '/api/v1/admin/gatekeeper/keys/:id/rotate',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const id = String(req.params.id ?? '');
      const rotated = await rotateGatekeeperKey(ctx.db, id);
      if (!rotated) {
        res.status(404).json({ error: 'gatekeeper key not found', code: 'NOT_FOUND' });
        return;
      }
      await recordAudit(ctx.db, {
        ...auditActor(req),
        action: 'gatekeeper_key.rotated',
        targetType: 'gatekeeper_key',
        targetId: rotated.key.id,
        summary: `Rotated Gatekeeper site key "${rotated.key.name}" (${rotated.key.keyPrefix})`,
        metadata: { keyPrefix: rotated.key.keyPrefix },
      });
      res.json(rotated);
    }),
  );

  router.post(
    '/api/v1/admin/gatekeeper/keys/:id/revoke',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const id = String(req.params.id ?? '');
      const revoked = await revokeGatekeeperKey(ctx.db, id);
      if (!revoked) {
        res.status(404).json({ error: 'gatekeeper key not found', code: 'NOT_FOUND' });
        return;
      }
      await recordAudit(ctx.db, {
        ...auditActor(req),
        action: 'gatekeeper_key.revoked',
        targetType: 'gatekeeper_key',
        targetId: revoked.id,
        summary: `Revoked Gatekeeper site key "${revoked.name}" (${revoked.keyPrefix})`,
      });
      res.json({ key: revoked });
    }),
  );

  router.delete(
    '/api/v1/admin/gatekeeper/keys/:id',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? '');
      const deleted = await deleteGatekeeperKey(ctx.db, id);
      if (!deleted) {
        res.status(404).json({ error: 'gatekeeper key not found', code: 'NOT_FOUND' });
        return;
      }
      await recordAudit(ctx.db, {
        ...auditActor(req),
        action: 'gatekeeper_key.deleted',
        targetType: 'gatekeeper_key',
        targetId: id,
        summary: `Deleted Gatekeeper site key ${id}`,
      });
      res.json({ ok: true });
    }),
  );

  return router;
}

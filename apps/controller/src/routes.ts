/**
 * HTTP route wiring for the Central Controller.
 *
 * Public API (JWT):        /api/v1/auth/*, /api/v1/me, /api/v1/network/config
 * Gatekeeper (Ed25519):    /api/v1/network/nodes/public-ips
 * Node internal (HMAC):    /internal/v1/node/*
 * Payments (HMAC webhook): /webhooks/payments
 */
import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { generateEd25519Keypair, signJson, loadSigningPrivateKey } from '@strict-proxy/types';
import type { PublicIpsResponse, SubscriptionTier, UserPublic } from '@strict-proxy/types';
import type { Db } from './db/client.js';
import { devices, nodes, subscriptions, users } from './db/schema.js';
import type { ControllerConfig } from './env.js';
import type { Redis } from 'ioredis';
import {
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeAccessToken,
} from './services/auth.js';
import { tierDefinition, isKnownTier } from './services/tiers.js';
import { buildSignedConfigBundle, buildNodeSyncState } from './services/config.js';
import { computeLoadScore } from './services/nodes.js';
import { asyncHandler, requireJwt, requireNodeHmac } from './middleware.js';

interface Ctx {
  db: Db;
  cfg: ControllerConfig;
  redis: Redis;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getSubscription(db: Db, userId: string): Promise<{ tier: SubscriptionTier; status: string; currentPeriodEnd: Date | null }> {
  const [row] = await db
    .select({ tier: subscriptions.tier, status: subscriptions.status, currentPeriodEnd: subscriptions.currentPeriodEnd })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  if (!row) return { tier: 'free', status: 'active', currentPeriodEnd: null };
  return {
    tier: isKnownTier(row.tier) ? row.tier : 'free',
    status: row.status,
    currentPeriodEnd: row.currentPeriodEnd,
  };
}

function toUserPublic(u: { id: string; email: string; role: string; createdAt: Date }, sub: { tier: SubscriptionTier; currentPeriodEnd: Date | null }): UserPublic {
  return {
    id: u.id,
    email: u.email,
    role: u.role as UserPublic['role'],
    tier: sub.tier,
    tierExpiresAt: sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

function issueTokenPair(ctx: Ctx, params: { userId: string; email: string; role: 'user' | 'admin'; tier: string; deviceId: string; deviceName?: string; seatLimit: number }) {
  return issueRefreshToken(ctx.db, ctx.cfg, {
    userId: params.userId,
    deviceId: params.deviceId,
    deviceName: params.deviceName,
    tier: params.tier,
    seatLimit: params.seatLimit,
  }).then((refreshToken) => {
    const accessToken = signAccessToken(ctx.cfg, {
      sub: params.userId,
      email: params.email,
      role: params.role,
      tier: params.tier,
      jti: randomBytes(16).toString('hex'),
      deviceId: params.deviceId,
    });
    return { accessToken, refreshToken, expiresIn: ctx.cfg.accessTokenTtlSeconds };
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function buildRouter(ctx: Ctx): Router {
  const router = Router();
  const requireAuth = requireJwt(ctx.cfg, ctx.db);

  // -- health ---------------------------------------------------------------
  router.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  // -- auth -----------------------------------------------------------------
  router.post(
    '/api/v1/auth/register',
    asyncHandler(async (req, res) => {
      const { email, password } = req.body as { email?: string; password?: string };
      if (!email || !password || password.length < 10) {
        res.status(400).json({ error: 'email and a password of at least 10 characters are required', code: 'VALIDATION' });
        return;
      }
      const passwordHash = await bcrypt.hash(password, 12);
      const [created] = await ctx.db
        .insert(users)
        .values({ email: email.toLowerCase().trim(), passwordHash })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id, email: users.email, role: users.role, createdAt: users.createdAt });
      if (!created) {
        res.status(409).json({ error: 'email already registered', code: 'EMAIL_TAKEN' });
        return;
      }
      await ctx.db.insert(subscriptions).values({ userId: created.id, tier: 'free', status: 'active' }).onConflictDoNothing({ target: subscriptions.userId });
      const sub = await getSubscription(ctx.db, created.id);
      res.status(201).json({ user: toUserPublic(created, sub) });
    }),
  );

  router.post(
    '/api/v1/auth/login',
    asyncHandler(async (req, res) => {
      const { email, password, deviceId, deviceName } = req.body as { email?: string; password?: string; deviceId?: string; deviceName?: string };
      if (!email || !password || !deviceId) {
        res.status(400).json({ error: 'email, password and deviceId are required', code: 'VALIDATION' });
        return;
      }
      const [user] = await ctx.db
        .select({ id: users.id, email: users.email, role: users.role, passwordHash: users.passwordHash, createdAt: users.createdAt })
        .from(users)
        .where(eq(users.email, email.toLowerCase().trim()))
        .limit(1);
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        res.status(401).json({ error: 'invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }
      const sub = await getSubscription(ctx.db, user.id);
      if (sub.status === 'revoked') {
        res.status(403).json({ error: 'subscription revoked; access denied', code: 'SUBSCRIPTION_REVOKED' });
        return;
      }
      const tokens = await issueTokenPair(ctx, {
        userId: user.id,
        email: user.email,
        role: user.role as 'user' | 'admin',
        tier: sub.tier,
        deviceId,
        deviceName,
        seatLimit: tierDefinition(sub.tier).deviceSeats,
      });
      res.json({ user: toUserPublic(user, sub), ...tokens });
    }),
  );

  router.post(
    '/api/v1/auth/refresh',
    asyncHandler(async (req, res) => {
      const { refreshToken, deviceId } = req.body as { refreshToken?: string; deviceId?: string };
      if (!refreshToken || !deviceId) {
        res.status(400).json({ error: 'refreshToken and deviceId are required', code: 'VALIDATION' });
        return;
      }
      const rotated = await rotateRefreshToken(ctx.db, ctx.cfg, refreshToken);
      if (!rotated || rotated.deviceId !== deviceId) {
        res.status(401).json({ error: 'invalid refresh token', code: 'INVALID_REFRESH' });
        return;
      }
      const [user] = await ctx.db
        .select({ id: users.id, email: users.email, role: users.role, createdAt: users.createdAt })
        .from(users)
        .where(eq(users.id, rotated.userId))
        .limit(1);
      if (!user) {
        res.status(401).json({ error: 'invalid refresh token', code: 'INVALID_REFRESH' });
        return;
      }
      const sub = await getSubscription(ctx.db, user.id);
      const tokens = await issueTokenPair(ctx, {
        userId: user.id,
        email: user.email,
        role: user.role as 'user' | 'admin',
        tier: sub.tier,
        deviceId: rotated.deviceId,
        seatLimit: tierDefinition(sub.tier).deviceSeats,
      });
      res.json({ user: toUserPublic(user, sub), ...tokens });
    }),
  );

  router.post(
    '/api/v1/auth/logout',
    requireAuth,
    asyncHandler(async (req, res) => {
      const claims = req.auth!;
      await revokeAccessToken(ctx.db, claims.jti, new Date(Date.now() + ctx.cfg.accessTokenTtlSeconds * 1000));
      res.json({ ok: true });
    }),
  );

  // -- user -----------------------------------------------------------------
  router.get(
    '/api/v1/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const claims = req.auth!;
      const [user] = await ctx.db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
      if (!user) {
        res.status(404).json({ error: 'user not found', code: 'NOT_FOUND' });
        return;
      }
      const sub = await getSubscription(ctx.db, user.id);
      const deviceRows = await ctx.db
        .select({ deviceId: devices.deviceId, deviceName: devices.deviceName, lastSeenAt: devices.lastSeenAt })
        .from(devices)
        .where(eq(devices.userId, user.id));
      res.json({ user: toUserPublic(user, sub), devices: deviceRows });
    }),
  );

  // -- network (client) ------------------------------------------------------
  router.get(
    '/api/v1/network/config',
    requireAuth,
    asyncHandler(async (req, res) => {
      const claims = req.auth!;
      const sub = await getSubscription(ctx.db, claims.sub);
      if (sub.status !== 'active' || (sub.currentPeriodEnd && sub.currentPeriodEnd < new Date())) {
        res.status(402).json({ error: 'active subscription required', code: 'SUBSCRIPTION_REQUIRED' });
        return;
      }
      const bundle = await buildSignedConfigBundle(ctx.db, ctx.cfg, { userId: claims.sub, tier: sub.tier });
      res.json(bundle);
    }),
  );

  // -- network (gatekeeper) ---------------------------------------------------
  router.get(
    '/api/v1/network/nodes/public-ips',
    asyncHandler(async (_req, res) => {
      const rows = await ctx.db
        .select({ publicIp: nodes.publicIp })
        .from(nodes)
        .where(eq(nodes.status, 'online'));
      const generatedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const ips = rows.map((r) => r.publicIp).sort();
      const payload = { generatedAt, expiresAt, ips };
      const signature = signJson(loadSigningPrivateKey(ctx.cfg.signingPrivateKeyPem), payload);
      const body: PublicIpsResponse = { ...payload, signature, keyId: ctx.cfg.signingKeyId };
      res.json(body);
    }),
  );

  // -- node internal API (HMAC) ----------------------------------------------
  const requireNode = requireNodeHmac(ctx.cfg, ctx.db, async (nodeId) => {
    const [row] = await ctx.db.select({ hmacSecret: nodes.hmacSecret }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    return row ? row.hmacSecret : null;
  });

  router.get(
    '/internal/v1/node/bootstrap',
    requireNode,
    asyncHandler(async (req, res) => {
      const [node] = await ctx.db.select().from(nodes).where(eq(nodes.id, req.node!.nodeId)).limit(1);
      if (!node) {
        res.status(404).json({ error: 'node not found', code: 'NOT_FOUND' });
        return;
      }
      res.json({
        nodeId: node.id,
        hostname: node.hostname,
        region: node.region,
        publicIp: node.publicIp,
        tunnelPort: node.tunnelPort,
        reality: {
          privateKey: node.realityPrivateKey,
          shortIds: node.realityShortIds,
          serverName: node.realityServerName,
        },
      });
    }),
  );

  router.post(
    '/internal/v1/node/heartbeat',
    requireNode,
    asyncHandler(async (req, res) => {
      const nodeId = req.node!.nodeId;
      const body = req.body as {
        cpuPercent?: number;
        memoryPercent?: number;
        bandwidthBytes?: number;
        uplinkRttMs?: number;
        uptimeSeconds?: number;
        engineVersion?: string;
      };
      const cpu = Number(body.cpuPercent ?? 0);
      const mem = Number(body.memoryPercent ?? 0);
      const load = computeLoadScore(cpu, mem);
      await ctx.db
        .update(nodes)
        .set({
          status: load > 90 ? 'degraded' : 'online',
          loadScore: load,
          engineVersion: body.engineVersion ?? 'unknown',
          lastHeartbeatAt: new Date(),
        })
        .where(eq(nodes.id, nodeId));
      res.json({ ok: true, controllerTime: new Date().toISOString() });
    }),
  );

  router.get(
    '/internal/v1/node/sync',
    requireNode,
    asyncHandler(async (req, res) => {
      const state = await buildNodeSyncState(ctx.db, req.node!.nodeId);
      res.json(state);
    }),
  );

  router.post(
    '/internal/v1/node/usage',
    requireNode,
    asyncHandler(async (req, res) => {
      const nodeId = req.node!.nodeId;
      const body = req.body as { usage?: Array<{ uuid: string; bytesUp: number; bytesDown: number; windowStart: string; windowEnd: string }> };
      const usage = Array.isArray(body.usage) ? body.usage : [];
      // Bandwidth accounting per credential (usage rollups are written by the
      // agent against the credential's UUID).
      for (const u of usage) {
        // Increment bytes_used on the matching credential.
        await ctx.db.execute(
          sql`UPDATE node_credentials SET bytes_used = bytes_used + ${u.bytesUp + u.bytesDown} WHERE uuid = ${u.uuid} AND node_id = ${nodeId}`,
        );
      }
      res.json({ ok: true, applied: usage.length });
    }),
  );

  // Fallback 404 as JSON.
  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
  });

  return router;
}

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
import { eq, sql, and, asc, desc, inArray, isNull } from 'drizzle-orm';
import { generateEd25519Keypair, signJson, loadSigningPrivateKey, isPublicIpAddress, normalizeIpAddress } from '@strict-proxy/types';
import type { PublicIpsResponse, SubscriptionTier, UserPublic } from '@strict-proxy/types';
import type { Db } from './db/client.js';
import { billingCheckouts, devices, nodeEnrollments, nodes, nodeCredentials, paymentEvents, refreshTokens, subscriptions, usageRollups, users } from './db/schema.js';
import type { ControllerConfig } from './env.js';
import type { Redis } from 'ioredis';
import {
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeAccessToken,
  revokeRefreshToken,
} from './services/auth.js';
import { tierDefinition, isKnownTier } from './services/tiers.js';
import { buildSignedConfigBundle, buildNodeSyncState } from './services/config.js';
import { applyObservedNodeIp, computeLoadScore, createNodeEnrollmentToken, enrollNode, registerNode, revokeAllUserCredentials } from './services/nodes.js';
import { publicIpFromRequest } from './services/client-ip.js';
import { rateLimit } from './services/rate-limit.js';
import { userBandwidthUsageInWindow, quotaWindowStart } from './services/usage.js';
import { asyncHandler, requireAdmin, requireJwt, requireNodeHmac } from './middleware.js';
import { mintEntitlementToken } from './services/entitlements.js';
import { auditActor, listAuditEntries, recordAudit } from './services/audit.js';

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

  router.get('/readyz', asyncHandler(async (_req, res) => {
    try {
      await ctx.db.execute(sql`select 1`);
      await ctx.redis.ping();
      res.json({ ok: true, time: new Date().toISOString() });
    } catch {
      res.status(503).json({ ok: false, code: 'DEPENDENCY_UNAVAILABLE' });
    }
  }));

  // -- auth -----------------------------------------------------------------
  // The whole auth surface is unauthenticated, so each endpoint gets its own
  // per-IP budget: an attacker cannot spend the login budget to unlock
  // unlimited registration, or vice versa.
  const limit = (bucket: string) =>
    rateLimit(ctx.cfg, { bucket, maxAttempts: ctx.cfg.rateLimitMaxAttempts, windowSeconds: ctx.cfg.rateLimitWindowSeconds });

  router.post(
    '/api/v1/auth/register',
    limit('auth.register'),
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
    limit('auth.login'),
    asyncHandler(async (req, res) => {
      const { email, password, deviceId, deviceName } = req.body as { email?: string; password?: string; deviceId?: string; deviceName?: string };
      if (!email || !password || !deviceId) {
        res.status(400).json({ error: 'email, password and deviceId are required', code: 'VALIDATION' });
        return;
      }
      const [user] = await ctx.db
        .select({ id: users.id, email: users.email, role: users.role, passwordHash: users.passwordHash, disabledAt: users.disabledAt, createdAt: users.createdAt })
        .from(users)
        .where(eq(users.email, email.toLowerCase().trim()))
        .limit(1);
      if (!user || user.disabledAt || !(await bcrypt.compare(password, user.passwordHash))) {
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
    limit('auth.refresh'),
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
        .select({ id: users.id, email: users.email, role: users.role, disabledAt: users.disabledAt, createdAt: users.createdAt })
        .from(users)
        .where(eq(users.id, rotated.userId))
        .limit(1);
      if (!user || user.disabledAt) {
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

      // Revoke the refresh token as well when the client sends it. Without this
      // a "logged out" client still holds a credential that can mint a fresh
      // access token, so the revocation above would buy nothing. Scoped to the
      // caller so this can only ever end their own session.
      const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '';
      if (refreshToken) await revokeRefreshToken(ctx.db, refreshToken, claims.sub);

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

  // -- admin -----------------------------------------------------------------
  // All operational controls are protected by both JWT authentication and the
  // administrator role. Payment provider calls remain webhook-driven.
  const requireAdministrator = [requireAuth, requireAdmin];

  router.get('/api/v1/admin/overview', ...requireAdministrator, asyncHandler(async (_req, res) => {
    const [userCount] = await ctx.db.select({ count: sql<number>`count(*)` }).from(users);
    const [activeSubscriptions] = await ctx.db.select({ count: sql<number>`count(*)` }).from(subscriptions).where(and(eq(subscriptions.status, 'active'), inArray(subscriptions.tier, ['standard', 'pro'])));
    const [onlineNodes] = await ctx.db.select({ count: sql<number>`count(*)` }).from(nodes).where(inArray(nodes.status, ['online', 'degraded']));
    const [credentialCount] = await ctx.db.select({ count: sql<number>`count(*)` }).from(nodeCredentials).where(eq(nodeCredentials.revoked, false));
    res.json({ users: Number(userCount?.count ?? 0), activeSubscriptions: Number(activeSubscriptions?.count ?? 0), onlineNodes: Number(onlineNodes?.count ?? 0), activeCredentials: Number(credentialCount?.count ?? 0) });
  }));

  router.get('/api/v1/admin/users', ...requireAdministrator, asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const rows = await ctx.db.select({ id: users.id, email: users.email, role: users.role, disabledAt: users.disabledAt, createdAt: users.createdAt, tier: subscriptions.tier, subscriptionStatus: subscriptions.status, currentPeriodEnd: subscriptions.currentPeriodEnd })
      .from(users).leftJoin(subscriptions, eq(subscriptions.userId, users.id)).orderBy(desc(users.createdAt)).limit(limit);
    res.json({ users: rows });
  }));

  /**
   * One account in full: subscription, devices, node credentials, payments and
   * the operator actions taken against it. The users table alone could not
   * answer "why did this customer lose access" without three other screens.
   */
  router.get('/api/v1/admin/users/:userId', ...requireAdministrator, asyncHandler(async (req, res) => {
    const userId = req.params.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
      res.status(400).json({ error: 'userId is required', code: 'VALIDATION' });
      return;
    }
    const [user] = await ctx.db
      .select({ id: users.id, email: users.email, role: users.role, disabledAt: users.disabledAt, createdAt: users.createdAt, updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) {
      res.status(404).json({ error: 'user not found', code: 'NOT_FOUND' });
      return;
    }
    const [subscription] = await ctx.db
      .select({
        tier: subscriptions.tier,
        status: subscriptions.status,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        provider: subscriptions.provider,
        providerCustomerId: subscriptions.providerCustomerId,
        providerSubscriptionId: subscriptions.providerSubscriptionId,
        updatedAt: subscriptions.updatedAt,
      })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);
    const [deviceRows, credentialRows, checkoutRows, auditRows] = await Promise.all([
      ctx.db
        .select({ deviceId: devices.deviceId, deviceName: devices.deviceName, lastSeenAt: devices.lastSeenAt, createdAt: devices.createdAt })
        .from(devices)
        .where(eq(devices.userId, userId)),
      ctx.db
        .select({ nodeId: nodeCredentials.nodeId, hostname: nodes.hostname, region: nodes.region, revoked: nodeCredentials.revoked, bytesUsed: nodeCredentials.bytesUsed, createdAt: nodeCredentials.createdAt })
        .from(nodeCredentials)
        .innerJoin(nodes, eq(nodes.id, nodeCredentials.nodeId))
        .where(eq(nodeCredentials.userId, userId)),
      ctx.db
        .select({ reference: billingCheckouts.reference, providerReference: billingCheckouts.providerReference, tier: billingCheckouts.tier, amountMinor: billingCheckouts.amountMinor, currency: billingCheckouts.currency, status: billingCheckouts.status, paidAt: billingCheckouts.paidAt, createdAt: billingCheckouts.createdAt })
        .from(billingCheckouts)
        .where(eq(billingCheckouts.userId, userId))
        .orderBy(desc(billingCheckouts.createdAt))
        .limit(20),
      listAuditEntries(ctx.db, { targetType: 'user', targetId: userId, limit: 20 }),
    ]);
    res.json({ user, subscription: subscription ?? null, devices: deviceRows, credentials: credentialRows, checkouts: checkoutRows, audit: auditRows });
  }));

  router.patch('/api/v1/admin/users/:userId', ...requireAdministrator, asyncHandler(async (req, res) => {
    const userId = req.params.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
      res.status(400).json({ error: 'userId is required', code: 'VALIDATION' });
      return;
    }
    const body = req.body as { disabled?: boolean; role?: 'user' | 'admin' };
    if (body.role !== undefined && body.role !== 'user' && body.role !== 'admin') {
      res.status(400).json({ error: 'role must be user or admin', code: 'VALIDATION' });
      return;
    }
    const [updated] = await ctx.db.update(users).set({
      ...(body.disabled === undefined ? {} : { disabledAt: body.disabled ? new Date() : null }),
      ...(body.role === undefined ? {} : { role: body.role }),
      updatedAt: new Date(),
    }).where(eq(users.id, userId)).returning({ id: users.id, email: users.email, role: users.role, disabledAt: users.disabledAt });
    if (!updated) {
      res.status(404).json({ error: 'user not found', code: 'NOT_FOUND' });
      return;
    }
    if (body.disabled === true) {
      await revokeAllUserCredentials(ctx.db, userId);
      await ctx.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), sql`${refreshTokens.revokedAt} IS NULL`));
    }
    const changes = [
      body.disabled === true ? 'disabled' : body.disabled === false ? 'enabled' : null,
      body.role === undefined ? null : `role set to ${body.role}`,
    ].filter(Boolean).join(', ');
    await recordAudit(ctx.db, {
      ...auditActor(req),
      action: 'user.updated',
      targetType: 'user',
      targetId: userId,
      summary: `${updated.email} ${changes || 'updated'}`,
      metadata: { disabled: body.disabled ?? null, role: body.role ?? null },
    });
    res.json({ user: updated });
  }));

  router.patch('/api/v1/admin/users/:userId/subscription', ...requireAdministrator, asyncHandler(async (req, res) => {
    const userId = req.params.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
      res.status(400).json({ error: 'userId is required', code: 'VALIDATION' });
      return;
    }
    const body = req.body as { tier?: string; status?: 'active' | 'expired' | 'revoked'; currentPeriodEnd?: string | null };
    const tier = body.tier;
    const status = body.status;
    if (!tier || !isKnownTier(tier) || !status || !['active', 'expired', 'revoked'].includes(status)) {
      res.status(400).json({ error: 'tier and a valid status are required', code: 'VALIDATION' });
      return;
    }
    const periodEnd = body.currentPeriodEnd === null || body.currentPeriodEnd === undefined ? null : new Date(body.currentPeriodEnd);
    if (periodEnd && Number.isNaN(periodEnd.getTime())) {
      res.status(400).json({ error: 'currentPeriodEnd must be a valid ISO date', code: 'VALIDATION' });
      return;
    }
    await ctx.db.insert(subscriptions).values({ userId, tier, status, currentPeriodEnd: periodEnd }).onConflictDoUpdate({ target: subscriptions.userId, set: { tier, status, currentPeriodEnd: periodEnd, updatedAt: new Date() } });
    if (status !== 'active') {
      await revokeAllUserCredentials(ctx.db, userId);
      await ctx.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), sql`${refreshTokens.revokedAt} IS NULL`));
    }
    await recordAudit(ctx.db, {
      ...auditActor(req),
      action: 'user.subscription_updated',
      targetType: 'user',
      targetId: userId,
      summary: `Subscription set to ${tier}/${status}`,
      metadata: { tier, status, currentPeriodEnd: periodEnd ? periodEnd.toISOString() : null },
    });
    const sub = await getSubscription(ctx.db, userId);
    res.json({ userId, subscription: sub });
  }));

  router.post('/api/v1/admin/node-enrollments', ...requireAdministrator, asyncHandler(async (req, res) => {
    const body = req.body as { region?: string; label?: string; ttlMinutes?: number };
    if (!body.region || body.region.trim().length < 2) {
      res.status(400).json({ error: 'region is required', code: 'VALIDATION' });
      return;
    }
    const ttlMinutes = Math.min(Math.max(Number(body.ttlMinutes ?? 30), 5), 24 * 60);
    const enrollment = createNodeEnrollmentToken();
    const [created] = await ctx.db.insert(nodeEnrollments).values({
      tokenHash: enrollment.tokenHash,
      region: body.region.trim(),
      label: body.label?.trim() || null,
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
      createdBy: req.auth!.sub,
    }).returning({ id: nodeEnrollments.id, expiresAt: nodeEnrollments.expiresAt, region: nodeEnrollments.region, label: nodeEnrollments.label });
    if (!created) {
      res.status(500).json({ error: 'enrollment creation failed', code: 'INTERNAL' });
      return;
    }
    await recordAudit(ctx.db, {
      ...auditActor(req),
      action: 'enrollment.issued',
      targetType: 'enrollment',
      targetId: created.id,
      summary: `Enrollment token issued for ${created.region}${created.label ? ` (${created.label})` : ''}`,
      metadata: { region: created.region, ttlMinutes },
    });
    res.status(201).json({ enrollmentId: created.id, token: enrollment.token, region: created.region, label: created.label, expiresAt: created.expiresAt });
  }));

  router.get('/api/v1/admin/node-enrollments', ...requireAdministrator, asyncHandler(async (_req, res) => {
    const rows = await ctx.db.select({ id: nodeEnrollments.id, region: nodeEnrollments.region, label: nodeEnrollments.label, expiresAt: nodeEnrollments.expiresAt, usedAt: nodeEnrollments.usedAt, nodeId: nodeEnrollments.nodeId, createdAt: nodeEnrollments.createdAt }).from(nodeEnrollments).orderBy(desc(nodeEnrollments.createdAt)).limit(200);
    res.json({ enrollments: rows });
  }));

  router.post('/api/v1/admin/node-enrollments/:enrollmentId/rotate', ...requireAdministrator, asyncHandler(async (req, res) => {
    const enrollmentId = req.params.enrollmentId;
    if (typeof enrollmentId !== 'string' || enrollmentId.length === 0) {
      res.status(400).json({ error: 'enrollmentId is required', code: 'VALIDATION' });
      return;
    }

    const result = await ctx.db.transaction(async (tx): Promise<{ enrollmentId: string; token: string; region: string; label: string | null; expiresAt: Date; rotatedFrom: string } | 'used' | null> => {
      const [existing] = await tx.select({ id: nodeEnrollments.id, region: nodeEnrollments.region, label: nodeEnrollments.label, createdAt: nodeEnrollments.createdAt, expiresAt: nodeEnrollments.expiresAt, usedAt: nodeEnrollments.usedAt }).from(nodeEnrollments).where(eq(nodeEnrollments.id, enrollmentId)).limit(1);
      if (!existing) return null;
      if (existing.usedAt) return 'used';

      const now = new Date();
      // Keep the operator's original lifetime, not the time left on the old
      // token: rotating near expiry must still produce a usable window.
      const originalTtlMinutes = Math.round((existing.expiresAt.getTime() - existing.createdAt.getTime()) / 60_000);
      const ttlMinutes = Math.min(Math.max(originalTtlMinutes, 5), 24 * 60);
      const enrollment = createNodeEnrollmentToken();

      const [revoked] = await tx.update(nodeEnrollments)
        .set({ expiresAt: now, usedAt: now })
        .where(and(eq(nodeEnrollments.id, enrollmentId), isNull(nodeEnrollments.usedAt)))
        .returning({ id: nodeEnrollments.id });
      if (!revoked) return 'used';

      const [created] = await tx.insert(nodeEnrollments).values({
        tokenHash: enrollment.tokenHash,
        region: existing.region,
        label: existing.label,
        expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
        createdBy: req.auth!.sub,
      }).returning({ id: nodeEnrollments.id, region: nodeEnrollments.region, label: nodeEnrollments.label, expiresAt: nodeEnrollments.expiresAt });
      if (!created) throw new Error('enrollment_rotation_failed');

      return { enrollmentId: created.id, token: enrollment.token, region: created.region, label: created.label, expiresAt: created.expiresAt, rotatedFrom: existing.id };
    });

    if (result === null) {
      res.status(404).json({ error: 'enrollment not found', code: 'NOT_FOUND' });
      return;
    }
    if (result === 'used') {
      res.status(409).json({ error: 'a consumed or revoked enrollment cannot be rotated', code: 'ENROLLMENT_ALREADY_CONSUMED' });
      return;
    }
    await recordAudit(ctx.db, {
      ...auditActor(req),
      action: 'enrollment.rotated',
      targetType: 'enrollment',
      targetId: result.enrollmentId,
      summary: `Enrollment token rotated for ${result.region}${result.label ? ` (${result.label})` : ''}`,
      metadata: { rotatedFrom: result.rotatedFrom, expiresAt: result.expiresAt.toISOString() },
    });
    res.status(201).json(result);
  }));

  router.delete('/api/v1/admin/node-enrollments/:enrollmentId', ...requireAdministrator, asyncHandler(async (req, res) => {
    const enrollmentId = req.params.enrollmentId;
    if (typeof enrollmentId !== 'string' || enrollmentId.length === 0) {
      res.status(400).json({ error: 'enrollmentId is required', code: 'VALIDATION' });
      return;
    }
    const [revoked] = await ctx.db.update(nodeEnrollments).set({ expiresAt: new Date(), usedAt: new Date() }).where(eq(nodeEnrollments.id, enrollmentId)).returning({ id: nodeEnrollments.id });
    if (!revoked) {
      res.status(404).json({ error: 'enrollment not found', code: 'NOT_FOUND' });
      return;
    }
    await recordAudit(ctx.db, {
      ...auditActor(req),
      action: 'enrollment.revoked',
      targetType: 'enrollment',
      targetId: enrollmentId,
      summary: `Enrollment token ${enrollmentId} revoked`,
    });
    res.json({ ok: true });
  }));

  router.post('/api/v1/nodes/enroll', limit('nodes.enroll'), asyncHandler(async (req, res) => {
    const body = req.body as { token?: string; hostname?: string; label?: string; publicIp?: string; tunnelPort?: number; realityServerName?: string; realityShortIds?: string[]; engineVersion?: string };
    if (!body.token || !body.hostname || !body.realityServerName || !body.realityShortIds?.length) {
      res.status(400).json({ error: 'token, hostname, realityServerName and realityShortIds are required', code: 'VALIDATION' });
      return;
    }

    // The operator may pin the address; otherwise fall back to the address the
    // enrolling node connected from. Either way it must be a public address —
    // `nodes.public_ip` is published in the list origins trust.
    const suppliedRaw = typeof body.publicIp === 'string' ? body.publicIp.trim() : '';
    const supplied = suppliedRaw ? normalizeIpAddress(suppliedRaw) : null;
    if (suppliedRaw && (supplied === null || !isPublicIpAddress(supplied))) {
      res.status(400).json({ error: 'publicIp must be a public address', code: 'VALIDATION' });
      return;
    }
    const publicIp = supplied ?? publicIpFromRequest(req);
    if (!publicIp) {
      res.status(400).json({
        error: 'could not determine a public IP for this node; set NODE_PUBLIC_IP on the node, or make sure TRUST_PROXY_HOPS matches your reverse proxies',
        code: 'PUBLIC_IP_REQUIRED',
      });
      return;
    }

    const enrolled = await enrollNode(ctx.db, {
      token: body.token,
      hostname: body.hostname,
      label: body.label,
      publicIp,
      publicIpSource: supplied ? 'enrollment' : 'autodetect',
      tunnelPort: Number(body.tunnelPort ?? 443),
      realityServerName: body.realityServerName,
      realityShortIds: body.realityShortIds,
      engineVersion: body.engineVersion ?? 'unknown',
    });
    res.status(201).json(enrolled);
  }));

  router.get('/api/v1/admin/nodes', ...requireAdministrator, asyncHandler(async (_req, res) => {
    const rows = await ctx.db.select({ id: nodes.id, hostname: nodes.hostname, region: nodes.region, label: nodes.label, publicIp: nodes.publicIp, publicIpSource: nodes.publicIpSource, publicIpUpdatedAt: nodes.publicIpUpdatedAt, tunnelPort: nodes.tunnelPort, status: nodes.status, loadScore: nodes.loadScore, engineVersion: nodes.engineVersion, lastHeartbeatAt: nodes.lastHeartbeatAt, registeredAt: nodes.registeredAt }).from(nodes).orderBy(asc(nodes.region), asc(nodes.label), asc(nodes.hostname));
    res.json({ nodes: rows });
  }));

  router.post('/api/v1/admin/nodes', ...requireAdministrator, asyncHandler(async (req, res) => {
    const body = req.body as { hostname?: string; region?: string; label?: string; publicIp?: string; tunnelPort?: number; realityPrivateKey?: string; realityPublicKey?: string; realityServerName?: string; realityShortIds?: string[]; engineVersion?: string };
    if (!body.hostname || !body.region || !body.publicIp || !body.realityServerName || !body.realityShortIds?.length) {
      res.status(400).json({ error: 'hostname, region, publicIp, realityServerName and realityShortIds are required', code: 'VALIDATION' });
      return;
    }
    const registered = await registerNode(ctx.db, { hostname: body.hostname, region: body.region, label: body.label, publicIp: body.publicIp, tunnelPort: Number(body.tunnelPort ?? 443), realityPrivateKey: body.realityPrivateKey, realityPublicKey: body.realityPublicKey, realityServerName: body.realityServerName, realityShortIds: body.realityShortIds, engineVersion: body.engineVersion ?? 'unknown' });
    res.status(201).json(registered);
  }));

  router.patch('/api/v1/admin/nodes/:nodeId', ...requireAdministrator, asyncHandler(async (req, res) => {
    const nodeId = req.params.nodeId;
    if (typeof nodeId !== 'string' || nodeId.length === 0) {
      res.status(400).json({ error: 'nodeId is required', code: 'VALIDATION' });
      return;
    }
    const body = req.body as { hostname?: string; region?: string; label?: string | null; publicIp?: string; tunnelPort?: number; status?: 'online' | 'degraded' | 'offline' | 'draining' };
    if (body.status === undefined && body.hostname === undefined && body.region === undefined && body.label === undefined && body.publicIp === undefined && body.tunnelPort === undefined) {
      res.status(400).json({ error: 'at least one node field is required', code: 'VALIDATION' });
      return;
    }
    if (body.tunnelPort !== undefined && (!Number.isInteger(body.tunnelPort) || body.tunnelPort < 1 || body.tunnelPort > 65535)) {
      res.status(400).json({ error: 'tunnelPort must be an integer from 1 to 65535', code: 'VALIDATION' });
      return;
    }
    if (body.status !== undefined && !['online', 'degraded', 'offline', 'draining'].includes(body.status)) {
      res.status(400).json({ error: 'valid status is required', code: 'VALIDATION' });
      return;
    }
    if (body.publicIp !== undefined && !isPublicIpAddress(body.publicIp)) {
      res.status(400).json({ error: 'publicIp must be a public address', code: 'VALIDATION' });
      return;
    }
    const [updated] = await ctx.db.update(nodes).set({
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.hostname === undefined ? {} : { hostname: body.hostname.trim() }),
      ...(body.region === undefined ? {} : { region: body.region.trim() }),
      ...(body.label === undefined ? {} : { label: body.label?.trim() || null }),
      ...(body.publicIp === undefined ? {} : { publicIp: normalizeIpAddress(body.publicIp)!, publicIpSource: 'manual', publicIpUpdatedAt: new Date() }),
      ...(body.tunnelPort === undefined ? {} : { tunnelPort: body.tunnelPort }),
    }).where(eq(nodes.id, nodeId)).returning({ id: nodes.id, hostname: nodes.hostname, region: nodes.region, label: nodes.label, publicIp: nodes.publicIp, publicIpSource: nodes.publicIpSource, publicIpUpdatedAt: nodes.publicIpUpdatedAt, tunnelPort: nodes.tunnelPort, status: nodes.status });
    if (!updated) {
      res.status(404).json({ error: 'node not found', code: 'NOT_FOUND' });
      return;
    }
    await recordAudit(ctx.db, {
      ...auditActor(req),
      action: 'node.updated',
      targetType: 'node',
      targetId: nodeId,
      summary: `Node ${updated.hostname} updated (${updated.status})`,
      metadata: { ...body },
    });
    res.json({ node: updated });
  }));

  router.delete('/api/v1/admin/nodes/:nodeId', ...requireAdministrator, asyncHandler(async (req, res) => {
    const nodeId = req.params.nodeId;
    if (typeof nodeId !== 'string' || nodeId.length === 0) {
      res.status(400).json({ error: 'nodeId is required', code: 'VALIDATION' });
      return;
    }
    const [removed] = await ctx.db.delete(nodes).where(eq(nodes.id, nodeId)).returning({ id: nodes.id, hostname: nodes.hostname });
    if (!removed) {
      res.status(404).json({ error: 'node not found', code: 'NOT_FOUND' });
      return;
    }
    await recordAudit(ctx.db, {
      ...auditActor(req),
      action: 'node.deleted',
      targetType: 'node',
      targetId: removed.id,
      summary: `Node ${removed.hostname} deleted`,
    });
    res.json({ ok: true });
  }));

  router.get('/api/v1/admin/payments/events', ...requireAdministrator, asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);
    const rows = await ctx.db.select().from(paymentEvents).orderBy(desc(paymentEvents.receivedAt)).limit(limit);
    res.json({ events: rows });
  }));

  /**
   * The operator action log, newest first. Narrowable by action, actor or
   * target so "who revoked this account" is a query rather than a search.
   */
  router.get('/api/v1/admin/audit', ...requireAdministrator, asyncHandler(async (req, res) => {
    const query = req.query as { limit?: string; action?: string; actorId?: string; targetType?: string; targetId?: string };
    const requestedLimit = Number(query.limit ?? 100);
    const entries = await listAuditEntries(ctx.db, {
      limit: Number.isFinite(requestedLimit) ? requestedLimit : 100,
      action: typeof query.action === 'string' && query.action ? query.action : undefined,
      actorId: typeof query.actorId === 'string' && query.actorId ? query.actorId : undefined,
      targetType: typeof query.targetType === 'string' && query.targetType ? query.targetType : undefined,
      targetId: typeof query.targetId === 'string' && query.targetId ? query.targetId : undefined,
    });
    res.json({ entries });
  }));
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
      // Enforce the tier's bandwidth quota before handing out working credentials.
      const quotaBytes = tierDefinition(sub.tier).bandwidthQuotaBytes;
      if (quotaBytes !== null) {
        const usedBytes = await userBandwidthUsageInWindow(ctx.db, claims.sub, quotaWindowStart());
        if (usedBytes >= quotaBytes) {
          res.status(402).json({
            error: 'bandwidth quota exhausted for the current period',
            code: 'BANDWIDTH_QUOTA_EXCEEDED',
            quotaBytes,
            usedBytes,
          });
          return;
        }
      }
      const bundle = await buildSignedConfigBundle(ctx.db, ctx.cfg, { userId: claims.sub, tier: sub.tier });
      res.json(bundle);
    }),
  );

  // -- entitlement tokens (gatekeeper sites) ---------------------------------
  router.get(
    '/api/v1/entitlement',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      res.json(await mintEntitlementToken(ctx.db, ctx.cfg, req.auth!.sub));
    }),
  );

  // -- network (gatekeeper) ---------------------------------------------------
  router.get(
    '/api/v1/network/nodes/public-ips',
    asyncHandler(async (_req, res) => {
      const rows = await ctx.db.select({ nodeId: nodes.id, hostname: nodes.hostname, region: nodes.region, label: nodes.label, publicIp: nodes.publicIp, status: nodes.status, loadScore: nodes.loadScore, lastHeartbeatAt: nodes.lastHeartbeatAt }).from(nodes).where(inArray(nodes.status, ['online', 'degraded'])).orderBy(nodes.region, nodes.label, nodes.hostname);
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
        /** The address the node sees for itself (from its IP echo service). */
        observedPublicIp?: string;
      };
      const cpu = Number(body.cpuPercent ?? 0);
      const mem = Number(body.memoryPercent ?? 0);
      const load = computeLoadScore(cpu, mem);
      const [node] = await ctx.db.select({ status: nodes.status }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
      if (!node) {
        res.status(404).json({ error: 'node not found', code: 'NOT_FOUND' });
        return;
      }
      await ctx.db
        .update(nodes)
        .set({
          status: node.status === 'draining' ? 'draining' : load > 90 ? 'degraded' : 'online',
          loadScore: load,
          engineVersion: body.engineVersion ?? 'unknown',
          lastHeartbeatAt: new Date(),
        })
        .where(eq(nodes.id, nodeId));

      // Keep the Gatekeeper allowlist pointing at where the node actually is.
      const ipChange = await applyObservedNodeIp(ctx.db, ctx.cfg, nodeId, body.observedPublicIp);
      if (ipChange.changed) {
        console.warn(`[controller] node ${nodeId} public IP auto-updated to ${ipChange.publicIp}`);
      }

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
      let applied = 0;
      for (const u of usage) {
        const bytesUp = Number(u.bytesUp);
        const bytesDown = Number(u.bytesDown);
        const windowStart = new Date(u.windowStart);
        const windowEnd = new Date(u.windowEnd);
        if (!Number.isFinite(bytesUp) || !Number.isFinite(bytesDown) || bytesUp < 0 || bytesDown < 0 || Number.isNaN(windowStart.getTime()) || Number.isNaN(windowEnd.getTime()) || windowEnd <= windowStart) continue;
        const [credential] = await ctx.db.select({ id: nodeCredentials.id }).from(nodeCredentials).where(and(eq(nodeCredentials.uuid, u.uuid), eq(nodeCredentials.nodeId, nodeId))).limit(1);
        if (!credential) continue;
        const [rollup] = await ctx.db.insert(usageRollups).values({ credentialId: credential.id, windowStart, windowEnd, bytesUp: Math.floor(bytesUp), bytesDown: Math.floor(bytesDown) }).onConflictDoNothing({ target: [usageRollups.credentialId, usageRollups.windowStart, usageRollups.windowEnd] }).returning({ id: usageRollups.id });
        if (!rollup) continue;
        await ctx.db.execute(sql`UPDATE node_credentials SET bytes_used = bytes_used + ${Math.floor(bytesUp + bytesDown)} WHERE id = ${credential.id}`);
        applied += 1;
      }
      res.json({ ok: true, applied });
    }),
  );

  // Fallback 404 as JSON.
  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
  });

  return router;
}

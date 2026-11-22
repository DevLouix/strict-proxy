/**
 * HTTP route wiring for the Central Controller.
 *
 * Public API (JWT):        /api/v1/auth/*, /api/v1/me, /api/v1/network/config,
 *                          /api/v1/network/session, /api/v1/links
 * Gatekeeper (Ed25519):    /api/v1/network/nodes/public-ips
 * Node internal (HMAC):    /internal/v1/node/*
 * Payments (HMAC webhook): /webhooks/payments
 */
import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { eq, sql, and, asc, desc, inArray, isNull, isNotNull, lte, ne, or } from 'drizzle-orm';
import { generateEd25519Keypair, signJson, loadSigningPrivateKey, isPublicIpAddress, normalizeIpAddress } from '@strict-proxy/types';
import type { PublicIpsResponse, SubscriptionTier, UserPublic } from '@strict-proxy/types';
import type { Db } from './db/client.js';
import { billingCheckouts, devices, gatedLinks, nodeEnrollments, nodes, nodeCredentials, paymentEvents, refreshTokens, subscriptions, usageRollups, users, vpnSessions } from './db/schema.js';
import type { ControllerConfig } from './env.js';
import type { Redis } from 'ioredis';
import {
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeAccessToken,
  revokeRefreshToken,
} from './services/auth.js';
import { tierDefinition, isPaidTier, isKnownTier } from './services/tiers.js';
import { buildSignedConfigBundle, buildNodeSyncState } from './services/config.js';
import { applyObservedNodeIp, computeLoadScore, createNodeEnrollmentToken, enrollNode, EnrollmentValidationError, registerNode, revokeAllUserCredentials, statusAfterHeartbeat, validateEnrollmentInput } from './services/nodes.js';
import { publicIpFromRequest } from './services/client-ip.js';
import { rateLimit } from './services/rate-limit.js';
import { userBandwidthUsageInWindow, quotaWindowStart } from './services/usage.js';
import { asyncHandler, requireAdmin, requireJwt, requireNodeHmac } from './middleware.js';
import {
  CLIENT_BUILD_HEADER,
  clientMeetsMinimum,
  clientUpdateRequiredBody,
  minimumClientBuild,
  parseClientBuild,
} from './services/client-version.js';
import { mintEntitlementToken } from './services/entitlements.js';
import { claimVpnSession, listVpnSessions } from './services/sessions.js';
import { buildLinksCatalog, normalizeLinkInput, type LinkInput } from './services/links.js';
import { auditActor, listAuditEntries, recordAudit } from './services/audit.js';
import { requirePermission } from './services/rbac.js';

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

/**
 * A refused client endpoint as the node pinned it, shaped for the log dialog.
 * The node derives it independently of the transcript, so it survives a burst
 * that shortens the lines.
 */
type NodeRefusedPeer = { endpoint: string; host?: string; at: string; attempts: number };

/**
 * Validates the pinned list a node POSTs: it is rendered in the admin console,
 * so an oversized or malformed entry must not reach the page.
 */
function sanitizeRefusedPeers(raw: unknown): NodeRefusedPeer[] {
  if (!Array.isArray(raw)) return [];
  const peers: NodeRefusedPeer[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    if (typeof value.endpoint !== 'string' || value.endpoint.trim() === '') continue;
    const attempts = Number(value.attempts);
    peers.push({
      endpoint: value.endpoint.trim().slice(0, 64),
      ...(typeof value.host === 'string' && value.host.trim() !== '' ? { host: value.host.trim().slice(0, 64) } : {}),
      at: typeof value.at === 'string' ? value.at.slice(0, 40) : new Date().toISOString(),
      attempts: Number.isFinite(attempts) && attempts > 0 ? Math.min(Math.floor(attempts), 1_000_000) : 1,
    });
  }
  return peers.slice(0, 20);
}

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

  router.get('/api/v1/admin/users', requirePermission(ctx.cfg, ctx.db, 'users.read'), asyncHandler(async (req, res) => {
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
  router.get('/api/v1/admin/users/:userId', requirePermission(ctx.cfg, ctx.db, 'users.read'), asyncHandler(async (req, res) => {
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

  /**
   * Creates an account from the dashboard.
   *
   * The password is hashed here and never returned; the operator shares it out
   * of band. The account starts on the free tier so every account has a
   * subscription row from the first request, and the creation is audited with
   * the acting administrator and the chosen role.
   */
  router.post('/api/v1/admin/users', requirePermission(ctx.cfg, ctx.db, 'users.create'), asyncHandler(async (req, res) => {
    const body = req.body as { email?: unknown; password?: unknown; role?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const role = body.role === undefined ? 'user' : body.role;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'a valid email address is required', code: 'VALIDATION' });
      return;
    }
    if (password.length < 10 || password.length > 200) {
      res.status(400).json({ error: 'password must be between 10 and 200 characters', code: 'VALIDATION' });
      return;
    }
    if (role !== 'user' && role !== 'admin') {
      res.status(400).json({ error: 'role must be user or admin', code: 'VALIDATION' });
      return;
    }

    const [existing] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) {
      res.status(409).json({ error: 'an account with that email already exists', code: 'EMAIL_TAKEN' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    let created: { id: string; email: string; role: string; createdAt: Date };
    try {
      created = await ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({ email, passwordHash, role })
          .returning({ id: users.id, email: users.email, role: users.role, createdAt: users.createdAt });
        if (!row) throw new Error('failed to create user');
        await tx
          .insert(subscriptions)
          .values({ userId: row.id, tier: 'free', status: 'active' })
          .onConflictDoNothing({ target: subscriptions.userId });
        return row;
      });
    } catch (error) {
      // The pre-check above races another creation of the same address; the
      // unique index is the authority, and its conflict is still a 409.
      if ((error as { code?: string }).code === '23505') {
        res.status(409).json({ error: 'an account with that email already exists', code: 'EMAIL_TAKEN' });
        return;
      }
      throw error;
    }

    await recordAudit(ctx.db, {
      ...auditActor(req),
      action: 'user.created',
      targetType: 'user',
      targetId: created.id,
      summary: `${created.email} created as ${created.role}`,
      metadata: { role: created.role },
    });
    res.status(201).json({ user: created });
  }));

  router.patch('/api/v1/admin/users/:userId', requirePermission(ctx.cfg, ctx.db, 'users.update'), asyncHandler(async (req, res) => {
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

    // Acting on your own account is the one case where the dashboard's Demote and
    // Disable buttons destroy the operator's own way back in: the next request is
    // refused and only a database edit recovers it. Refuse it here, so the rule
    // holds even when the request does not come from the dashboard.
    const isSelf = req.auth?.sub === userId;
    if (isSelf && body.role === 'user') {
      res.status(409).json({ error: 'you cannot demote your own account; ask another administrator', code: 'SELF_DEMOTION' });
      return;
    }
    if (isSelf && body.disabled === true) {
      res.status(409).json({ error: 'you cannot disable your own account', code: 'SELF_DISABLE' });
      return;
    }

    // The same lockout from the other side: demoting or disabling the last
    // administrator leaves a deployment with nobody able to administer it.
    if (body.role === 'user' || body.disabled === true) {
      const [target] = await ctx.db
        .select({ role: users.role, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!target) {
        res.status(404).json({ error: 'user not found', code: 'NOT_FOUND' });
        return;
      }
      if (target.role === 'admin' && target.disabledAt === null) {
        const [remaining] = await ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(users)
          .where(and(eq(users.role, 'admin'), sql`${users.disabledAt} IS NULL`));
        if (Number(remaining?.count ?? 0) <= 1) {
          res.status(409).json({ error: 'this is the last active administrator; promote another account first', code: 'LAST_ADMIN' });
          return;
        }
      }
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

  router.patch('/api/v1/admin/users/:userId/subscription', requirePermission(ctx.cfg, ctx.db, 'users.subscription'), asyncHandler(async (req, res) => {
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

  /**
   * Deletes every finished token record in one action.
   *
   * Used and expired rows are only history; without this, the enrollment list
   * grows forever. Active tokens are deliberately kept so an enrollment that is
   * currently in progress cannot be swept away.
   */
  router.delete('/api/v1/admin/node-enrollments', ...requireAdministrator, asyncHandler(async (req, res) => {
    const deleted = await ctx.db.delete(nodeEnrollments)
      .where(or(isNotNull(nodeEnrollments.usedAt), lte(nodeEnrollments.expiresAt, new Date())))
      .returning({ id: nodeEnrollments.id });
    if (deleted.length > 0) {
      await recordAudit(ctx.db, {
        ...auditActor(req),
        action: 'enrollments.purged',
        targetType: 'enrollment',
        summary: `${deleted.length} finished enrollment token${deleted.length === 1 ? '' : 's'} deleted`,
        metadata: { count: deleted.length },
      });
    }
    res.json({ ok: true, deleted: deleted.length });
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
    const [existing] = await ctx.db.select({ usedAt: nodeEnrollments.usedAt, expiresAt: nodeEnrollments.expiresAt })
      .from(nodeEnrollments).where(eq(nodeEnrollments.id, enrollmentId)).limit(1);
    if (!existing) {
      res.status(404).json({ error: 'enrollment not found', code: 'NOT_FOUND' });
      return;
    }
    const state = existing.usedAt ? 'used' : existing.expiresAt.getTime() <= Date.now() ? 'expired' : 'active';
    // A hard delete is the point: marking the row used would keep exactly the
    // garbage the list is being cleaned of. The token hash disappears with it.
    await ctx.db.delete(nodeEnrollments).where(eq(nodeEnrollments.id, enrollmentId));
    await recordAudit(ctx.db, {
      ...auditActor(req),
      action: 'enrollment.deleted',
      targetType: 'enrollment',
      targetId: enrollmentId,
      summary: `Enrollment token ${enrollmentId} deleted (${state})`,
      metadata: { state },
    });
    res.json({ ok: true, deleted: true });
  }));

  router.post('/api/v1/nodes/enroll', limit('nodes.enroll'), asyncHandler(async (req, res) => {
    const body = req.body as { publicIp?: string };
    // Everything except the IP is validated centrally (services/nodes.ts), so a
    // malformed short id or tunnel port is a 400 the agent can report rather
    // than a config sing-box rejects after a successful enrollment.
    let input: ReturnType<typeof validateEnrollmentInput>;
    try {
      input = validateEnrollmentInput(req.body);
    } catch (err) {
      if (err instanceof EnrollmentValidationError) {
        res.status(400).json({ error: err.message, code: 'VALIDATION' });
        return;
      }
      throw err;
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

    let enrolled: { nodeId: string; hmacSecret: string; region: string };
    try {
      enrolled = await enrollNode(ctx.db, {
        token: input.token,
        hostname: input.hostname,
        label: input.label ?? undefined,
        publicIp,
        publicIpSource: supplied ? 'enrollment' : 'autodetect',
        tunnelPort: input.tunnelPort,
        realityServerName: input.realityServerName,
        realityShortIds: input.realityShortIds,
        engineVersion: input.engineVersion,
      });
    } catch (err) {
      // Rebuilding a VPS (new volume, same NODE_HOSTNAME) leaves the old node
      // row behind, and `nodes_hostname_uq` rejected the insert. That surfaced
      // as a bare 500 that the agent could only echo, so an operator had no way
      // to know a stale node was the problem. The whole enrollment transaction
      // rolls back, which is why the token is still usable after this.
      // Drizzle wraps driver errors in a DrizzleQueryError whose `cause` is the
      // pg error, and drivers disagree on the field name (pg: `constraint`,
      // postgres.js: `constraint_name`), so walk the chain for the real one.
      type PgError = { code?: string; constraint?: string; constraint_name?: string; detail?: string; message?: string; cause?: unknown };
      let pg: PgError | null = null;
      for (let cur: unknown = err, depth = 0; cur && depth < 4; depth++) {
        const node = cur as PgError;
        if (node.code) { pg = node; break; }
        cur = node.cause;
      }
      const conflict = `${pg?.constraint ?? pg?.constraint_name ?? ''} ${pg?.detail ?? ''} ${pg?.message ?? ''}`;
      if (pg?.code === '23505' && conflict.includes('nodes_hostname')) {
        res.status(409).json({
          error:
            `a node named "${input.hostname}" already exists; delete it in Admin -> Nodes (this also cascades its credentials), ` +
            'then retry this enrollment with the same token, or set NODE_HOSTNAME to a different name',
          code: 'NODE_HOSTNAME_IN_USE',
        });
        return;
      }
      throw err;
    }
    res.status(201).json(enrolled);
  }));

  router.get('/api/v1/admin/nodes', ...requireAdministrator, asyncHandler(async (_req, res) => {
    const rows = await ctx.db.select({ id: nodes.id, hostname: nodes.hostname, region: nodes.region, label: nodes.label, publicIp: nodes.publicIp, publicIpSource: nodes.publicIpSource, publicIpUpdatedAt: nodes.publicIpUpdatedAt, tunnelPort: nodes.tunnelPort, status: nodes.status, loadScore: nodes.loadScore, engineVersion: nodes.engineVersion, agentBuild: nodes.agentBuild, engineHealthy: nodes.engineHealthy, statsApiHealthy: nodes.statsApiHealthy, engineHealthCheckedAt: nodes.engineHealthCheckedAt, lastHeartbeatAt: nodes.lastHeartbeatAt, registeredAt: nodes.registeredAt }).from(nodes).orderBy(asc(nodes.region), asc(nodes.label), asc(nodes.hostname));
    // Bandwidth per node, so the fleet view can show whether usage is actually
    // flowing without opening `docker logs`. Sums are over every rollup the node
    // ever reported (total) and over the last 24 hours.
    const usage = await ctx.db
      .select({
        nodeId: nodeCredentials.nodeId,
        totalBytes: sql<string>`coalesce(sum(${usageRollups.bytesUp} + ${usageRollups.bytesDown}), 0)`,
        last24hBytes: sql<string>`coalesce(sum(case when ${usageRollups.windowStart} >= now() - interval '24 hours' then ${usageRollups.bytesUp} + ${usageRollups.bytesDown} else 0 end), 0)`,
        lastReportedAt: sql<string | null>`max(${usageRollups.windowEnd})`,
      })
      .from(usageRollups)
      .innerJoin(nodeCredentials, eq(nodeCredentials.id, usageRollups.credentialId))
      .groupBy(nodeCredentials.nodeId);
    const usageByNode = new Map(usage.map((u) => [u.nodeId, u]));
    res.json({
      nodes: rows.map((node) => {
        const totals = usageByNode.get(node.id);
        return {
          ...node,
          usageTotalBytes: Number(totals?.totalBytes ?? 0),
          usage24hBytes: Number(totals?.last24hBytes ?? 0),
          usageLastReportedAt: totals?.lastReportedAt ?? null,
        };
      }),
    });
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

  // Admin requests for a node's log lines, waiting for its next heartbeat.
  // Held in memory only; a node that does not answer within the timeout gets an
  // error that names which of the two possible reasons it is.
  const pendingNodeLogs = new Map<
    string,
    {
      /** Heartbeats the node reported while this request was waiting. */
      heartbeats: number;
      /**
       * Build the node reported while this request was waiting. Null on an
       * image that predates the marker, which is what makes a stale image
       * distinguishable from a build whose log POST was rejected.
       */
      build: string | null;
      resolve: (payload: { lines: Array<{ at: string; level: string; msg: string }>; refusedPeers: NodeRefusedPeer[] }) => void;
    }
  >();

  router.get('/api/v1/admin/nodes/:nodeId/logs', ...requireAdministrator, asyncHandler(async (req, res) => {
    const nodeId = String(req.params.nodeId);
    const [node] = await ctx.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) {
      res.status(404).json({ error: 'node not found', code: 'NOT_FOUND' });
      return;
    }
    if (pendingNodeLogs.has(nodeId)) {
      res.status(409).json({ error: 'a log request for this node is already waiting', code: 'CONFLICT' });
      return;
    }
    // Longer than one heartbeat interval (30s by default) on purpose: the node
    // can only answer the request on its next heartbeat, so a shorter wait
    // gave an operator a 504 most of the time and made the button look broken.
    // Still under the 60s a default Traefik read timeout allows.
    const outcome = await new Promise<{
      lines: Array<{ at: string; level: string; msg: string }> | null;
      refusedPeers: NodeRefusedPeer[];
      heartbeats: number;
      build: string | null;
    }>((resolve) => {
      const waiter = {
        heartbeats: 0,
        build: null as string | null,
        resolve: (payload: { lines: Array<{ at: string; level: string; msg: string }>; refusedPeers: NodeRefusedPeer[] }) => {
          clearTimeout(timer);
          resolve({ ...payload, heartbeats: waiter.heartbeats, build: waiter.build });
        },
      };
      const timer = setTimeout(() => {
        pendingNodeLogs.delete(nodeId);
        resolve({ lines: null, refusedPeers: [], heartbeats: waiter.heartbeats, build: waiter.build });
      }, 55_000);
      pendingNodeLogs.set(nodeId, waiter);
    });
    if (!outcome.lines) {
      // A node that keeps heartbeating but never posts lines is not offline.
      // Two different faults looked identical here: an image too old to know the
      // `sendLogs` reply, and a current image whose POST never arrived. Only the
      // older one is fixed by deploying a newer image, so the build the node
      // reported on those heartbeats decides which answer the operator gets.
      if (outcome.heartbeats === 0) {
        res.status(504).json({
          error: 'the node sent no heartbeat while the request waited, so it is offline',
          code: 'TIMEOUT',
        });
      } else if (outcome.build) {
        res.status(504).json({
          error:
            `the node is heartbeating and reports agent build ${outcome.build}, which knows live logs, ` +
            'but its log POST never arrived. Look at that node\'s own output for "could not post log lines": ' +
            'an HMAC mismatch after a secret rotation, or a proxy rejecting the POST, is the usual cause.',
          code: 'LOGS_NOT_POSTED',
        });
      } else {
        res.status(504).json({
          error:
            'the node is heartbeating but reported no agent build and sent no logs: its image predates both ' +
            'live logs and the build marker. Pull a current node-agent image on the node ' +
            '(`docker compose -f docker-compose.dokploy-node.yml pull node-agent`) and recreate the container.',
          code: 'LOGS_UNSUPPORTED',
        });
      }
      return;
    }
    res.json({ lines: outcome.lines, refusedPeers: outcome.refusedPeers });
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

  /**
   * Rotates a node's HMAC secret in place, without re-enrollment.
   *
   * The previous secret keeps verifying for `graceHours` so the operator can
   * update the agent and restart it without the node leaving the fleet in
   * between. `graceHours: 0` retires it immediately, which is what a secret
   * believed to be leaked needs. The new secret is returned once and is never
   * exposed by a GET route or written to the audit log.
   */
  router.post('/api/v1/admin/nodes/:nodeId/rotate-secret', ...requireAdministrator, asyncHandler(async (req, res) => {
    const nodeId = req.params.nodeId;
    if (typeof nodeId !== 'string' || nodeId.length === 0) {
      res.status(400).json({ error: 'nodeId is required', code: 'VALIDATION' });
      return;
    }
    const body = req.body as { graceHours?: number };
    const graceHours = Number(body.graceHours ?? 24);
    if (!Number.isFinite(graceHours) || graceHours < 0 || graceHours > 168) {
      res.status(400).json({ error: 'graceHours must be between 0 and 168', code: 'VALIDATION' });
      return;
    }
    const [node] = await ctx.db.select({ id: nodes.id, hostname: nodes.hostname, hmacSecret: nodes.hmacSecret }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) {
      res.status(404).json({ error: 'node not found', code: 'NOT_FOUND' });
      return;
    }

    const secret = randomBytes(32).toString('base64url');
    const previousValidUntil = graceHours > 0 ? new Date(Date.now() + graceHours * 3_600_000) : null;
    await ctx.db.update(nodes).set({
      hmacSecret: secret,
      previousHmacSecret: graceHours > 0 ? node.hmacSecret : null,
      previousHmacSecretExpiresAt: previousValidUntil,
    }).where(eq(nodes.id, nodeId));

    await recordAudit(ctx.db, {
      ...auditActor(req),
      action: 'node.secret_rotated',
      targetType: 'node',
      targetId: nodeId,
      summary: `HMAC secret rotated for ${node.hostname}`,
      metadata: { graceHours, previousValidUntil: previousValidUntil ? previousValidUntil.toISOString() : null },
    });
    res.status(201).json({
      nodeId,
      secret,
      previousValidUntil: previousValidUntil ? previousValidUntil.toISOString() : null,
    });
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
  // -- admin: gated links -----------------------------------------------------
  // A link is a site an operator has already put behind the Gatekeeper. This
  // records it so registered users can find it, and names the plan the site
  // requires so the app can explain what the account can and cannot open.
  router.get('/api/v1/admin/links', ...requireAdministrator, asyncHandler(async (_req, res) => {
    const rows = await ctx.db.select().from(gatedLinks).orderBy(asc(gatedLinks.sortOrder), asc(gatedLinks.title));
    res.json({ links: rows });
  }));

  router.post('/api/v1/admin/links', ...requireAdministrator, asyncHandler(async (req, res) => {
    let input: Partial<LinkInput>;
    try {
      input = normalizeLinkInput(req.body);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message, code: 'VALIDATION' });
      return;
    }
    const [created] = await ctx.db
      .insert(gatedLinks)
      .values({
        title: input.title!,
        url: input.url!,
        description: input.description ?? null,
        requiredTier: input.requiredTier!,
        active: input.active ?? true,
        sortOrder: input.sortOrder ?? 0,
        createdBy: req.auth!.sub,
      })
      .onConflictDoNothing({ target: gatedLinks.url })
      .returning();
    if (!created) {
      res.status(409).json({ error: 'a link with this URL already exists', code: 'DUPLICATE_LINK' });
      return;
    }
    await recordAudit(ctx.db, {
      ...auditActor(req),
      action: 'link.created',
      targetType: 'link',
      targetId: created.id,
      summary: `Link "${created.title}" published for ${created.requiredTier}`,
      metadata: { url: created.url, requiredTier: created.requiredTier },
    });
    res.status(201).json({ link: created });
  }));

  router.patch('/api/v1/admin/links/:id', ...requireAdministrator, asyncHandler(async (req, res) => {
    const linkId = req.params.id;
    if (typeof linkId !== 'string' || linkId.length === 0) {
      res.status(400).json({ error: 'linkId is required', code: 'VALIDATION' });
      return;
    }
    let input: Partial<LinkInput>;
    try {
      input = normalizeLinkInput(req.body, { partial: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message, code: 'VALIDATION' });
      return;
    }
    if (Object.keys(input).length === 0) {
      res.status(400).json({ error: 'nothing to update', code: 'VALIDATION' });
      return;
    }
    const [updated] = await ctx.db
      .update(gatedLinks)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(gatedLinks.id, linkId))
      .returning();
    if (!updated) {
      res.status(404).json({ error: 'link not found', code: 'NOT_FOUND' });
      return;
    }
    await recordAudit(ctx.db, {
      ...auditActor(req),
      action: 'link.updated',
      targetType: 'link',
      targetId: updated.id,
      summary: `Link "${updated.title}" updated`,
      metadata: { requiredTier: updated.requiredTier, active: updated.active },
    });
    res.json({ link: updated });
  }));

  router.delete('/api/v1/admin/links/:id', ...requireAdministrator, asyncHandler(async (req, res) => {
    const linkId = req.params.id;
    if (typeof linkId !== 'string' || linkId.length === 0) {
      res.status(400).json({ error: 'linkId is required', code: 'VALIDATION' });
      return;
    }
    const [removed] = await ctx.db.delete(gatedLinks).where(eq(gatedLinks.id, linkId)).returning({ id: gatedLinks.id, title: gatedLinks.title });
    if (!removed) {
      res.status(404).json({ error: 'link not found', code: 'NOT_FOUND' });
      return;
    }
    await recordAudit(ctx.db, {
      ...auditActor(req),
      action: 'link.deleted',
      targetType: 'link',
      targetId: removed.id,
      summary: `Link "${removed.title}" deleted`,
    });
    res.json({ ok: true });
  }));

  // -- network (client) ------------------------------------------------------

  /**
   * Claims a seat for the calling install.
   *
   * A plan's `deviceSeats` bounds how many installs may hold a tunnel; a claim
   * beyond the limit displaces the least-recently-seen install, whose
   * credentials the next bundle request revokes. Repeating the call from the
   * same install is a no-op, so a reconnect does not churn credentials.
   */
  router.post(
    '/api/v1/network/session',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as { deviceId?: string };
      const presented = (typeof body.deviceId === 'string' ? body.deviceId : req.header('x-device-id') ?? '').trim();
      // The access token is minted for one install, and that is the id the
      // config route looks up. Seating whatever id the body happens to carry
      // let one phone own a seat under an id its own token never matched, so a
      // single install was refused for holding no seat. The token wins; a body
      // id is only consulted for tokens minted before identity moved into it.
      const tokenDevice = typeof req.auth!.deviceId === 'string' ? req.auth!.deviceId.trim() : '';
      const deviceId = tokenDevice.length > 0 ? tokenDevice : presented;
      if (deviceId.length === 0 || deviceId.length > 200) {
        res.status(400).json({ error: 'deviceId is required', code: 'VALIDATION' });
        return;
      }
      const sub = await getSubscription(ctx.db, req.auth!.sub);
      const claim = await claimVpnSession(ctx.db, {
        userId: req.auth!.sub,
        deviceId,
        // Seats are installs, not concurrent logins: each device row owns one
        // credential, and a shared UUID cannot create a second row.
        seatLimit: tierDefinition(sub.tier).deviceSeats,
      });
      if (claim.superseded) {
        await recordAudit(ctx.db, {
          ...auditActor(req),
          action: 'session.superseded',
          targetType: 'user',
          targetId: req.auth!.sub,
          summary: `Proxy session moved to a newer device; ${claim.superseded.deviceId} was revoked`,
          metadata: { deviceId, supersededDeviceId: claim.superseded.deviceId },
        });
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json(claim);
    }),
  );

  /** Whether the presented session id still owns the account's proxy session. */
  router.get(
    '/api/v1/network/session',
    requireAuth,
    asyncHandler(async (req, res) => {
      const claims = req.auth!;
      const sessions = await listVpnSessions(ctx.db, claims.sub);
      const presented = req.header('x-session-id') ?? '';
      // Without the header the access token still names the install it was
      // minted for, so report that install's seat instead of "not current".
      const mine = presented
        ? (sessions.find((s) => s.sessionId === presented) ?? null)
        : (sessions.find((s) => s.deviceId === claims.deviceId) ?? null);
      const newest = sessions.length > 0 ? sessions[sessions.length - 1]! : null;
      res.setHeader('Cache-Control', 'no-store');
      // `current` answers "does this install still hold a seat", not "is it the
      // only one": a device must not close itself down just because the account
      // also connected somewhere else.
      res.json({
        current: sessions.length === 0 ? true : mine !== null,
        sessionId: mine?.sessionId ?? newest?.sessionId ?? null,
        deviceId: mine?.deviceId ?? newest?.deviceId ?? null,
        startedAt: mine?.startedAt ?? newest?.startedAt ?? null,
        lastSeenAt: mine?.lastSeenAt ?? newest?.lastSeenAt ?? null,
        devices: sessions.length,
      });
    }),
  );

  router.get(
    '/api/v1/network/config',
    requireAuth,
    asyncHandler(async (req, res) => {
      const claims = req.auth!;
      // Credentials are withheld from builds the operator has retired. This is
      // the enforcement point because a tunnel cannot be configured without
      // this response; refusing at sign-in would leave already-signed-in older
      // installs working until their tokens expired.
      const minimum = await minimumClientBuild(ctx.db, ctx.cfg);
      const build = parseClientBuild(req.header(CLIENT_BUILD_HEADER));
      if (!clientMeetsMinimum(build, minimum)) {
        res.status(426).json(clientUpdateRequiredBody(minimum!, build));
        return;
      }
      const sub = await getSubscription(ctx.db, claims.sub);
      // A free row is not a trial: it exists so status and limits always have a
      // value, but only a paid tier that is currently active gets credentials.
      if (!isPaidTier(sub.tier) || sub.status !== 'active' || (sub.currentPeriodEnd && sub.currentPeriodEnd < new Date())) {
        res.status(402).json({ error: 'active paid subscription required', code: 'SUBSCRIPTION_REQUIRED' });
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
      // A session id that holds no seat is refused: it belonged to this
      // account's install that a newer one has displaced, and handing it
      // credentials would revive a tunnel the seats have already given away.
      const sessions = await listVpnSessions(ctx.db, claims.sub);
      const presented = req.header('x-session-id');
      const mine = presented ? (sessions.find((s) => s.sessionId === presented) ?? null) : null;
      if (presented && !mine) {
        res.status(409).json({
          error: 'this account is connected on another device',
          code: 'SESSION_SUPERSEDED',
        });
        return;
      }
      // The access token is minted for one install, so it names the caller even
      // when the session header is missing: an older build, or a proxy that
      // drops custom headers. It is also the id a claim seats, so a request can
      // no longer be refused for presenting an id its own seat was never
      // written under.
      const tokenDevice = typeof claims.deviceId === 'string' ? claims.deviceId.trim() : '';
      let deviceId = mine?.deviceId ?? tokenDevice;
      // An authenticated install with no seat of its own has not claimed yet: a
      // build from before the claim call, or one whose local install id was
      // regenerated after signing in. Seat it under the token's id here rather
      // than refuse, because the plan already bounds the rows: this adds no
      // capacity, and a shared credential still displaces the stalest install
      // exactly as a claim would.
      if (!mine && tokenDevice.length > 0 && !sessions.some((s) => s.deviceId === tokenDevice)) {
        const claimed = await claimVpnSession(ctx.db, {
          userId: claims.sub,
          deviceId: tokenDevice,
          seatLimit: tierDefinition(sub.tier).deviceSeats,
        });
        deviceId = claimed.deviceId;
      }
      // Only a token minted before install identity moved into it can reach
      // this: nothing in the request names an install to seat.
      if (deviceId.length === 0) {
        res.status(409).json({
          error: 'this install does not hold a seat on the account; reconnect to claim one',
          code: 'SEAT_REQUIRED',
        });
        return;
      }
      const bundle = await buildSignedConfigBundle(ctx.db, ctx.cfg, { userId: claims.sub, tier: sub.tier, deviceId });
      // One line per issued bundle, because neither the device nor the database
      // is reachable from here: with this and the node agent's applied-user
      // line, the credential the app is dialling with can be matched against the
      // users the node accepts. Only a prefix of each UUID is logged.
      console.log(
        `[controller] config bundle issued user=${claims.sub} device=${deviceId} ` +
          `nodes=${bundle.nodes.map((n) => n.id).join(',') || 'none'} ` +
          `credentials=${Object.values(bundle.configs)
            .map((c) => `${c.uuid.slice(0, 8)}/${c.shortId}`)
            .join(',') || 'none'} expires=${bundle.expiresAt}`,
      );
      res.setHeader('Cache-Control', 'no-store');
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

  // -- gated links (client) ---------------------------------------------------
  /**
   * The account's link feed.
   *
   * Registered accounts see every active link, but items above their plan are
   * returned locked and without a URL. The upgrade hint is computed here so the
   * app, a third-party client and tests all state the same thing.
   */
  router.get(
    '/api/v1/links',
    requireAuth,
    asyncHandler(async (req, res) => {
      const claims = req.auth!;
      const sub = await getSubscription(ctx.db, claims.sub);
      const live = sub.status === 'active' && isPaidTier(sub.tier) && (!sub.currentPeriodEnd || sub.currentPeriodEnd > new Date());
      const tier: SubscriptionTier = live ? sub.tier : 'free';
      const rows = await ctx.db
        .select({
          id: gatedLinks.id,
          title: gatedLinks.title,
          url: gatedLinks.url,
          description: gatedLinks.description,
          requiredTier: gatedLinks.requiredTier,
        })
        .from(gatedLinks)
        .where(eq(gatedLinks.active, true))
        .orderBy(asc(gatedLinks.sortOrder), asc(gatedLinks.title));
      // A ticket per request: a link shared or left in browser history stops
      // working when the short-lived token expires.
      const ticket = live ? (await mintEntitlementToken(ctx.db, ctx.cfg, claims.sub)).token : null;
      res.setHeader('Cache-Control', 'no-store');
      res.json({ tier, ...buildLinksCatalog(rows, tier, ticket) });
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
    const [row] = await ctx.db.select({
      hmacSecret: nodes.hmacSecret,
      previousHmacSecret: nodes.previousHmacSecret,
      previousHmacSecretExpiresAt: nodes.previousHmacSecretExpiresAt,
    }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!row) return null;
    const secrets = [row.hmacSecret];
    if (row.previousHmacSecret && row.previousHmacSecretExpiresAt && row.previousHmacSecretExpiresAt.getTime() > Date.now()) {
      secrets.push(row.previousHmacSecret);
    }
    return secrets;
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

  /**
   * Takes this node out of rotation while its agent restarts the engine.
   *
   * A restart drops every tunnel the node carries, and a client assigned in the
   * second before it fails to connect. It refuses when this is the only online
   * node: draining then removes every server, so new users could not fetch
   * credentials at all. The expiry means a restart that never completes cannot
   * strand the node; the agent also clears the flag explicitly afterwards.
   */
  router.post(
    '/internal/v1/node/drain',
    requireNode,
    asyncHandler(async (req, res) => {
      const nodeId = req.node!.nodeId;
      const body = req.body as { draining?: boolean };
      if (typeof body.draining !== 'boolean') {
        res.status(400).json({ error: 'draining must be a boolean', code: 'VALIDATION' });
        return;
      }
      const [node] = await ctx.db
        .select({ status: nodes.status, loadScore: nodes.loadScore, autoDrainUntil: nodes.autoDrainUntil })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1);
      if (!node) {
        res.status(404).json({ error: 'node not found', code: 'NOT_FOUND' });
        return;
      }

      if (body.draining) {
        const [other] = await ctx.db
          .select({ id: nodes.id })
          .from(nodes)
          .where(and(eq(nodes.status, 'online'), ne(nodes.id, nodeId)))
          .limit(1);
        if (!other) {
          res.json({ draining: false, reason: 'last_online_node' });
          return;
        }
        await ctx.db
          .update(nodes)
          .set({ status: 'draining', autoDrainUntil: new Date(Date.now() + 3 * 60_000) })
          .where(eq(nodes.id, nodeId));
        res.json({ draining: true });
        return;
      }

      if (!node.autoDrainUntil) {
        // An operator's drain, or an already-cleared one: leave it alone.
        res.json({ draining: node.status === 'draining' });
        return;
      }
      await ctx.db
        .update(nodes)
        .set({ status: node.loadScore > 90 ? 'degraded' : 'online', autoDrainUntil: null })
        .where(eq(nodes.id, nodeId));
      res.json({ draining: false });
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
        /** Commit the agent image was built from; absent on older images. */
        agentBuild?: string;
        /** Self-check from the agent: the engine is running, usage collection works. */
        engineHealthy?: boolean;
        statsApiHealthy?: boolean;
        /** The address the node sees for itself (from its IP echo service). */
        observedPublicIp?: string;
        /** The port the engine listens on; clients are handed this port. */
        tunnelPort?: number;
      };
      const cpu = Number(body.cpuPercent ?? 0);
      const mem = Number(body.memoryPercent ?? 0);
      const load = computeLoadScore(cpu, mem);
      if (
        body.tunnelPort !== undefined &&
        (!Number.isInteger(body.tunnelPort) || body.tunnelPort < 1 || body.tunnelPort > 65535)
      ) {
        res.status(400).json({ error: 'tunnelPort must be an integer from 1 to 65535', code: 'VALIDATION' });
        return;
      }
      const [node] = await ctx.db
        .select({ status: nodes.status, tunnelPort: nodes.tunnelPort, autoDrainUntil: nodes.autoDrainUntil })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1);
      if (!node) {
        res.status(404).json({ error: 'node not found', code: 'NOT_FOUND' });
        return;
      }
      const nextStatus = statusAfterHeartbeat(node, load);
      await ctx.db
        .update(nodes)
        .set({
          status: nextStatus.status,
          ...(nextStatus.clearAutoDrain ? { autoDrainUntil: null } : {}),
          loadScore: load,
          engineVersion: body.engineVersion ?? 'unknown',
          // Omitted keeps the previous value: an agent without the marker must
          // not erase the build a newer one already reported.
          ...(typeof body.agentBuild === 'string' && body.agentBuild.trim() !== ''
            ? { agentBuild: body.agentBuild.trim().slice(0, 64) }
            : {}),
          // Omitted fields keep the previous value so a node that does not
          // report health is never silently marked unhealthy.
          ...(typeof body.engineHealthy === 'boolean' ? { engineHealthy: body.engineHealthy } : {}),
          ...(typeof body.statsApiHealthy === 'boolean' ? { statsApiHealthy: body.statsApiHealthy } : {}),
          ...(typeof body.engineHealthy === 'boolean' || typeof body.statsApiHealthy === 'boolean'
            ? { engineHealthCheckedAt: new Date() }
            : {}),
          // Omitted keeps the enrolled value; a changed port is what clients
          // are handed next, so it must follow the engine rather than drift.
          ...(body.tunnelPort === undefined ? {} : { tunnelPort: body.tunnelPort }),
          lastHeartbeatAt: new Date(),
        })
        .where(eq(nodes.id, nodeId));

      if (body.tunnelPort !== undefined && body.tunnelPort !== node.tunnelPort) {
        console.warn(
          `[controller] node ${nodeId} tunnel port changed ${node.tunnelPort} -> ${body.tunnelPort}; ` +
            'clients will be handed the new port on their next config fetch',
        );
      }

      // Keep the Gatekeeper allowlist pointing at where the node actually is.
      const ipChange = await applyObservedNodeIp(ctx.db, ctx.cfg, nodeId, body.observedPublicIp);
      if (ipChange.changed) {
        console.warn(`[controller] node ${nodeId} public IP auto-updated to ${ipChange.publicIp}`);
      }

      // Counted so a timed-out request can say whether the node was reachable:
      // a heartbeat that arrived without the lines is the signature of an agent
      // build that does not know the `sendLogs` reply.
      const logWaiter = pendingNodeLogs.get(nodeId);
      if (logWaiter) {
        logWaiter.heartbeats += 1;
        if (typeof body.agentBuild === 'string' && body.agentBuild.trim() !== '') logWaiter.build = body.agentBuild.trim();
      }

      res.json({
        ok: true,
        controllerTime: new Date().toISOString(),
        // Tells the agent to post its buffered lines to /internal/v1/node/logs.
        sendLogs: Boolean(logWaiter),
      });
    }),
  );

  router.post(
    '/internal/v1/node/logs',
    requireNode,
    asyncHandler(async (req, res) => {
      const nodeId = req.node!.nodeId;
      const body = req.body as { logs?: Array<{ at: string; level: string; msg: string }>; refusedPeers?: unknown };
      const waiter = pendingNodeLogs.get(nodeId);
      if (waiter && Array.isArray(body.logs)) {
        pendingNodeLogs.delete(nodeId);
        waiter.resolve({
          lines: body.logs
            .filter((l) => l && typeof l.msg === 'string')
            // Larger than the agent's own single-source caps: the POST already
            // carries a per-source budget, and re-capping the whole list here
            // was a second place a flood could push out the snapshot.
            .slice(-600)
            .map((l) => ({ at: String(l.at), level: String(l.level), msg: String(l.msg).slice(0, 500) })),
          refusedPeers: sanitizeRefusedPeers(body.refusedPeers),
        });
      }
      res.json({ ok: true, delivered: Boolean(waiter) });
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

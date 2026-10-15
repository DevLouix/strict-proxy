/**
 * Billing routes for authenticated users: the price catalog, checkout
 * creation, subscription state, and usage against the tier quota.
 */
import { Router, type Request, type Response } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import type { Redis } from 'ioredis';
import type { SubscriptionTier } from '@strict-proxy/types';
import { subscriptions, nodeCredentials, billingCheckouts, users } from '../db/schema.js';
import { asyncHandler, requireJwt } from '../middleware.js';
import { isKnownTier, tierDefinition, nextPeriodEnd } from '../services/tiers.js';
import { BillingError, purchasableTiers, validateBillingConfig } from '../services/catalog.js';
import { isOpenPayConfigured, describeOpenPayError } from '../services/openpay.js';
import { createTierCheckout, latestCheckoutForUser } from '../services/billing.js';
import { userBandwidthUsageInWindow, quotaWindowStart } from '../services/usage.js';
import { rateLimit } from '../services/rate-limit.js';

interface Ctx {
  db: Db;
  cfg: ControllerConfig;
  redis: Redis;
}

export function buildBillingRouter(ctx: Ctx): Router {
  const router = Router();
  const requireAuth = requireJwt(ctx.cfg, ctx.db);

  router.get(
    '/api/v1/billing/catalog',
    requireAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      res.json({
        gateway: isOpenPayConfigured(ctx.cfg) ? 'openpay' : 'unconfigured',
        currency: ctx.cfg.billingCurrency,
        tiers: purchasableTiers(ctx.cfg),
        quotaWindowDays: 30,
      });
    }),
  );

  router.get(
    '/api/v1/billing/subscription',
    requireAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const claims = req.auth!;
      const [sub] = await ctx.db
        .select({ tier: subscriptions.tier, status: subscriptions.status, currentPeriodEnd: subscriptions.currentPeriodEnd })
        .from(subscriptions)
        .where(eq(subscriptions.userId, claims.sub))
        .limit(1);

      const tier = sub && isKnownTier(sub.tier) ? (sub.tier as SubscriptionTier) : 'free';
      const definition = tierDefinition(tier);
      const usedBytes = await userBandwidthUsageInWindow(ctx.db, claims.sub, quotaWindowStart());
      const latest = await latestCheckoutForUser(ctx.db, claims.sub);

      res.json({
        tier,
        status: sub?.status ?? 'active',
        currentPeriodEnd: sub?.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
        limits: {
          deviceSeats: definition.deviceSeats,
          maxNodes: definition.maxNodes,
          bandwidthQuotaBytes: definition.bandwidthQuotaBytes,
        },
        usage: {
          windowStart: quotaWindowStart().toISOString(),
          windowEnd: new Date().toISOString(),
          bytesUsed: usedBytes,
          bytesRemaining: definition.bandwidthQuotaBytes === null ? null : Math.max(0, definition.bandwidthQuotaBytes - usedBytes),
        },
        pendingCheckout: latest && latest.status === 'open' ? { reference: latest.reference, tier: latest.tier, expiresAt: latest.expiresAt?.toISOString() ?? null } : null,
      });
    }),
  );

  router.post(
    '/api/v1/billing/checkout',
    requireAuth,
    // Opening checkouts creates payable provider sessions; keep it throttled.
    rateLimit(ctx.cfg, { bucket: 'billing.checkout', maxAttempts: ctx.cfg.rateLimitMaxAttempts, windowSeconds: ctx.cfg.rateLimitWindowSeconds }),
    asyncHandler(async (req: Request, res: Response) => {
      const claims = req.auth!;
      if (!isOpenPayConfigured(ctx.cfg)) {
        res.status(503).json({ error: 'billing gateway is not configured', code: 'BILLING_NOT_CONFIGURED' });
        return;
      }

      const body = req.body as { tier?: string; successUrl?: string; cancelUrl?: string };
      try {
        validateBillingConfig(ctx.cfg);
        const checkout = await createTierCheckout(ctx.db, ctx.cfg, {
          userId: claims.sub,
          email: claims.email,
          tier: (body.tier ?? 'standard') as SubscriptionTier,
          successUrl: body.successUrl,
          cancelUrl: body.cancelUrl,
        });
        res.status(201).json(checkout);
      } catch (err) {
        if (err instanceof BillingError) {
          const status = err.code === 'unknown_tier' ? 400 : 409;
          res.status(status).json({ error: err.message, code: err.code.toUpperCase() });
          return;
        }
        // Surface the gateway's own reason instead of a bare "internal error":
        // "no configured providers" is actionable, "internal error" is not.
        const described = describeOpenPayError(err);
        console.error(`[controller] openpay checkout failed (${described.code}):`, err);
        res.status(described.status).json({
          error: described.message,
          code: described.code,
          providerCode: described.providerCode,
          retryable: described.retryable,
        });
      }
    }),
  );

  /** Usage detail per node, so the client can show where bandwidth went. */
  router.get(
    '/api/v1/billing/usage',
    requireAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const claims = req.auth!;
      const rows = await ctx.db
        .select({
          nodeId: nodeCredentials.nodeId,
          uuid: nodeCredentials.uuid,
          bytesUsed: nodeCredentials.bytesUsed,
          revoked: nodeCredentials.revoked,
        })
        .from(nodeCredentials)
        .where(eq(nodeCredentials.userId, claims.sub));

      const total = rows.reduce((acc, r) => acc + Number(r.bytesUsed ?? 0), 0);
      res.json({ totalBytes: total, credentials: rows });
    }),
  );

  /**
   * Individual checkouts, newest first.
   *
   * This is the first thing anyone needs when a customer says they paid but
   * still have no access: it shows what was offered, whether it settled, and
   * both the provider reference and the user the checkout belongs to.
   */
  router.get(
    '/api/v1/admin/billing/checkouts',
    requireJwt(ctx.cfg, ctx.db),
    asyncHandler(async (req: Request, res: Response) => {
      if (req.auth?.role !== 'admin') {
        res.status(403).json({ error: 'administrator access required', code: 'FORBIDDEN' });
        return;
      }
      const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);
      const status = typeof req.query.status === 'string' && req.query.status.length > 0 ? req.query.status : null;

      const base = ctx.db
        .select({
          reference: billingCheckouts.reference,
          providerReference: billingCheckouts.providerReference,
          tier: billingCheckouts.tier,
          amountMinor: billingCheckouts.amountMinor,
          currency: billingCheckouts.currency,
          status: billingCheckouts.status,
          expiresAt: billingCheckouts.expiresAt,
          paidAt: billingCheckouts.paidAt,
          createdAt: billingCheckouts.createdAt,
          userId: billingCheckouts.userId,
          email: users.email,
        })
        .from(billingCheckouts)
        .innerJoin(users, eq(users.id, billingCheckouts.userId));

      const rows = await (status ? base.where(eq(billingCheckouts.status, status)) : base)
        .orderBy(desc(billingCheckouts.createdAt))
        .limit(limit);

      res.json({
        checkouts: rows.map((r) => ({
          reference: r.reference,
          providerReference: r.providerReference,
          tier: r.tier,
          amountMinor: r.amountMinor,
          currency: r.currency,
          status: r.status,
          expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
          paidAt: r.paidAt ? r.paidAt.toISOString() : null,
          createdAt: r.createdAt.toISOString(),
          user: { id: r.userId, email: r.email },
        })),
      });
    }),
  );

  /** Aggregate the platform's revenue-relevant figures for the admin UI. */
  router.get(
    '/api/v1/admin/billing/summary',
    requireJwt(ctx.cfg, ctx.db),
    asyncHandler(async (req: Request, res: Response) => {
      if (req.auth?.role !== 'admin') {
        res.status(403).json({ error: 'administrator access required', code: 'FORBIDDEN' });
        return;
      }
      const [checkouts] = await ctx.db
        .select({
          total: sql<number>`count(*)`,
          paid: sql<number>`count(*) FILTER (WHERE status = 'paid')`,
          open: sql<number>`count(*) FILTER (WHERE status = 'open')`,
          expired: sql<number>`count(*) FILTER (WHERE status = 'expired')`,
        })
        .from((await import('../db/schema.js')).billingCheckouts);

      const [revenue] = await ctx.db
        .select({ gross: sql<string>`coalesce(sum(amount_minor), 0)`, currency: sql<string>`max(currency)` })
        .from((await import('../db/schema.js')).billingCheckouts)
        .where(sql`status = 'paid'`);

      res.json({
        checkouts: {
          total: Number(checkouts?.total ?? 0),
          paid: Number(checkouts?.paid ?? 0),
          open: Number(checkouts?.open ?? 0),
          expired: Number(checkouts?.expired ?? 0),
        },
        revenue: { grossMinor: Number(revenue?.gross ?? 0), currency: revenue?.currency ?? ctx.cfg.billingCurrency },
        gateway: isOpenPayConfigured(ctx.cfg) ? 'openpay' : 'unconfigured',
      });
    }),
  );

  return router;
}
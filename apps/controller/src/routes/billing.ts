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
import { isKnownTier, tierDefinition } from '../services/tiers.js';
import { BillingError, purchasableTiers, validateBillingConfig, priceForTier } from '../services/catalog.js';
import { loadBillingCurrency, loadPriceOverrides } from '../services/pricing.js';
import { isOpenPayConfigured, describeOpenPayError, createOpenPayClient } from '../services/openpay.js';
import { createTierCheckout, latestCheckoutForUser } from '../services/billing.js';
import { activateRecurringSubscription } from '../services/recurring.js';
import { userBandwidthUsageInWindow, quotaWindowStart } from '../services/usage.js';
import { rateLimit } from '../services/rate-limit.js';
import {
  CouponError,
  discountMinorFor,
  linkCouponRedemption,
  normalizeCouponCode,
  previewCoupon,
  releaseCoupon,
  reserveCoupon,
  type CouponRow,
} from '../services/coupons.js';


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
      const currency = await loadBillingCurrency(ctx.db, ctx.cfg);
      const overrides = await loadPriceOverrides(ctx.db, ctx.cfg, currency);
      res.json({
        gateway: isOpenPayConfigured(ctx.cfg) ? 'openpay' : 'unconfigured',
        currency,
        tiers: purchasableTiers(ctx.cfg, overrides, currency),
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
        .select({
          tier: subscriptions.tier,
          status: subscriptions.status,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          providerSubscriptionId: subscriptions.providerSubscriptionId,
        })
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
        // True once the saved card is attached to a monthly provider
        // subscription. The client uses this to enable auto-renew after the
        // first verified payment without asking the user to pay twice.
        autoRenew: Boolean(sub?.providerSubscriptionId),
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

  /**
   * Prices a code before the customer pays.
   *
   * Returns the discounted amount per purchasable tier, so the app can show
   * what will actually be charged rather than a discount it has to compute
   * itself. Validation is the same function checkout uses, so a price shown
   * here is the price that will be reserved.
   */
  router.post(
    '/api/v1/billing/coupon/preview',
    requireAuth,
    rateLimit(ctx.cfg, { bucket: 'billing.coupon', maxAttempts: ctx.cfg.rateLimitMaxAttempts, windowSeconds: ctx.cfg.rateLimitWindowSeconds }),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { code?: unknown };
      try {
        const preview = await previewCoupon(ctx.db, String(body.code ?? ''));
        const currency = await loadBillingCurrency(ctx.db, ctx.cfg);
        const overrides = await loadPriceOverrides(ctx.db, ctx.cfg, currency);
        const row: CouponRow = {
          id: '',
          code: preview.code,
          kind: preview.kind,
          percentOff: preview.percentOff,
          amountOffMinor: preview.amountOffMinor,
          currency: preview.currency,
          maxRedemptions: preview.maxRedemptions,
          timesRedeemed: preview.timesRedeemed,
          active: true,
          expiresAt: preview.expiresAt ? new Date(preview.expiresAt) : null,
          note: null,
        };
        const tiers = purchasableTiers(ctx.cfg, overrides, currency).map(({ tier, price }) => {
          const discountMinor = discountMinorFor(row, price.amountMinor, price.currency);
          return {
            tier,
            label: price.label,
            currency: price.currency,
            amountBeforeMinor: price.amountMinor,
            discountMinor,
            amountAfterMinor: price.amountMinor - discountMinor,
          };
        });
        res.json({ ...preview, tiers });
      } catch (err) {
        if (err instanceof CouponError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
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

      const body = req.body as { tier?: string; successUrl?: string; cancelUrl?: string; couponCode?: string };
      const couponCode = body.couponCode === undefined ? null : normalizeCouponCode(body.couponCode);
      if (body.couponCode !== undefined && couponCode === null) {
        res.status(400).json({ error: 'that code is not valid', code: 'COUPON_INVALID' });
        return;
      }

      try {
        validateBillingConfig(ctx.cfg);
        const tier = (body.tier ?? 'standard') as SubscriptionTier;

        // Reserve before opening a payable session: the amount is discounted
        // first, so the limit has to be enforced before the provider sees it.
        let reservation: Awaited<ReturnType<typeof reserveCoupon>> | null = null;
        if (couponCode) {
          const currency = await loadBillingCurrency(ctx.db, ctx.cfg);
          const overrides = await loadPriceOverrides(ctx.db, ctx.cfg, currency);
          const price = priceForTier(ctx.cfg, tier, overrides, currency);
          reservation = await reserveCoupon(ctx.db, {
            code: couponCode,
            userId: claims.sub,
            amountBeforeMinor: price.amountMinor,
            currency: price.currency,
          });
        }

        let checkout: Awaited<ReturnType<typeof createTierCheckout>>;
        try {
          checkout = await createTierCheckout(ctx.db, ctx.cfg, {
            userId: claims.sub,
            email: claims.email,
            tier,
            successUrl: body.successUrl,
            cancelUrl: body.cancelUrl,
            ...(reservation
              ? {
                  coupon: {
                    code: reservation.code,
                    discountMinor: reservation.discountMinor,
                    amountMinor: reservation.amountMinor,
                  },
                }
              : {}),
          });
        } catch (err) {
          // No session was created, so the use must not stay consumed.
          if (reservation) await releaseCoupon(ctx.db, reservation.couponId, claims.sub);
          throw err;
        }
        if (reservation) {
          await linkCouponRedemption(ctx.db, {
            couponId: reservation.couponId,
            userId: claims.sub,
            checkoutReference: checkout.reference,
          });
        }
        res.status(201).json(checkout);
      } catch (err) {
        if (err instanceof CouponError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
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

  /**
   * Starts the monthly subscription from the card saved by the first checkout.
   *
   * Safe to call repeatedly: an account that is already recurring is reported
   * as active and nothing is created twice. Non-eligible accounts get a 200
   * with `activated: false` and a reason the app can display, rather than an
   * error that looks like a server fault.
   */
  router.post(
    '/api/v1/billing/recurring/activate',
    requireAuth,
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const result = await activateRecurringSubscription(ctx.db, ctx.cfg, req.auth!.sub);
        res.json(result);
      } catch (err) {
        const described = describeOpenPayError(err);
        console.error(`[controller] recurring activation failed (${described.code}):`, err);
        res.status(described.status).json({
          activated: false,
          error: described.message,
          code: described.code,
          providerCode: described.providerCode,
          retryable: described.retryable,
        });
      }
    }),
  );

  /** Usage detail per node, so the client can show where bandwidth went. */
  /**
   * A receipt for a settled checkout.
   *
   * Closes most of the "no email" gap without wiring an email provider: OpenPay
   * already renders an invoice/receipt for a charge, so we surface it on demand
   * rather than sending it.
   */
  router.get(
    '/api/v1/billing/receipt/:reference',
    requireAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const claims = req.auth!;
      const reference = typeof req.params.reference === 'string' ? req.params.reference : '';
      if (!reference) {
        res.status(400).json({ error: 'reference is required', code: 'VALIDATION' });
        return;
      }

      // Scoped to the caller: a reference must not reveal someone else's receipt.
      const [row] = await ctx.db
        .select({
          reference: billingCheckouts.reference,
          providerReference: billingCheckouts.providerReference,
          status: billingCheckouts.status,
          tier: billingCheckouts.tier,
          amountMinor: billingCheckouts.amountMinor,
          currency: billingCheckouts.currency,
          paidAt: billingCheckouts.paidAt,
        })
        .from(billingCheckouts)
        .where(and(eq(billingCheckouts.reference, reference), eq(billingCheckouts.userId, claims.sub)))
        .limit(1);

      if (!row) {
        res.status(404).json({ error: 'no such checkout for this account', code: 'NOT_FOUND' });
        return;
      }

      const receipt: Record<string, unknown> = {
        reference: row.reference,
        providerReference: row.providerReference,
        status: row.status,
        tier: row.tier,
        amountMinor: row.amountMinor,
        currency: row.currency,
        paidAt: row.paidAt ? row.paidAt.toISOString() : null,
      };

      // A settled checkout can additionally be rendered as a provider receipt.
      if (row.status === 'paid' && row.providerReference && isOpenPayConfigured(ctx.cfg)) {
        try {
          const client = createOpenPayClient(ctx.cfg);
          receipt['invoice'] = await client.charges.invoice(row.providerReference, 'html');
        } catch (err) {
          // The ledger row stays valid even if the provider cannot render it.
          console.error('[controller] could not render provider receipt:', err);
        }
      }

      res.json(receipt);
    }),
  );

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
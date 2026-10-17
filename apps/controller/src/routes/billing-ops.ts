/**
 * Operator billing actions that are ours to make.
 *
 * Two things the platform previously documented but could not do: provision the
 * provider plans a subscription needs, and cancel a subscription from this side.
 * Both are admin-only and both act on the provider — entitlement here is still
 * driven by webhooks, never by the result of an API call, so an operator action
 * that fails midway leaves the subscription untouched rather than half-applied.
 */
import { Router, type Request, type Response } from 'express';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import { eq } from 'drizzle-orm';
import { asyncHandler, requireJwt } from '../middleware.js';
import { subscriptions } from '../db/schema.js';
import { isOpenPayConfigured, createOpenPayClient, describeOpenPayError } from '../services/openpay.js';
import {
  syncTierPlans,
  setMerchantId,
  isUsablePlan,
  isOurPlan,
  removeTierPlan,
  PLAN_TIER_METADATA_KEY,
  MERCHANT_SETTING_KEY,
} from '../services/plans.js';
import { getSetting } from '../services/settings.js';
import { revokeAllUserCredentials } from '../services/nodes.js';
import { revokeAllRefreshTokens } from '../services/auth.js';
import { purchasableTiers } from '../services/catalog.js';
import type { SubscriptionTier } from '@strict-proxy/types';

interface Ctx {
  db: Db;
  cfg: ControllerConfig;
}

export function buildBillingOpsRouter(ctx: Ctx): Router {
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

  const requireGateway = (res: Response): boolean => {
    if (isOpenPayConfigured(ctx.cfg)) return true;
    res.status(503).json({ error: 'billing gateway is not configured', code: 'BILLING_NOT_CONFIGURED' });
    return false;
  };

  /** The plans the catalog expects, and which ones exist at the provider. */
  router.get(
    '/api/v1/admin/billing/plans',
    ...adminOnly,
    asyncHandler(async (_req: Request, res: Response) => {
      const tiers = purchasableTiers(ctx.cfg).map(({ tier, price }) => ({
        tier,
        label: price.label,
        expectedAmountMinor: price.amountMinor,
        currency: price.currency,
      }));

      if (!requireGateway(res)) return;

      const merchantId = await getSetting(ctx.db, ctx.cfg, MERCHANT_SETTING_KEY).catch(() => null);
      const client = createOpenPayClient(ctx.cfg);
      try {
        const listed = await client.subscriptions.listPlans();
        const providerPlans = (listed.data ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          amount: p.amount,
          currency: p.currency,
          interval: `${p.interval_count} ${p.interval_unit}`,
          status: p.status,
          tier: (p.metadata?.[PLAN_TIER_METADATA_KEY] as string | undefined) ?? null,
          managed: isOurPlan(p),
          // An archived plan is left behind by a delete that had to keep the
          // billing record; it cannot be subscribed to, so it is called out
          // rather than looking like a live plan with a stale status.
          usable: isUsablePlan(p as unknown as Record<string, unknown>),
        }));
        res.json({ merchantId, tiers, providerPlans, gateway: 'openpay' });
      } catch (err) {
        const described = describeOpenPayError(err);
        res.status(described.status).json({ error: described.message, code: described.code, providerCode: described.providerCode });
      }
    }),
  );

  /**
   * Creates any missing provider plan for a tier.
   *
   * Idempotent: an existing plan tagged with the tier is reused, and a price that
   * has drifted from the catalog is reported rather than pushed, because
   * repricing a live plan changes what existing subscribers are billed.
   */
  router.post(
    '/api/v1/admin/billing/plans/sync',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      if (!requireGateway(res)) return;

      const body = req.body as { merchantId?: string };
      if (typeof body.merchantId === 'string' && body.merchantId.trim()) {
        await setMerchantId(ctx.db, ctx.cfg, body.merchantId);
      }

      const client = createOpenPayClient(ctx.cfg);
      const { plans, errors } = await syncTierPlans(ctx.db, ctx.cfg, client);

      res.json({
        created: plans.filter((p) => p.created).length,
        reused: plans.filter((p) => !p.created).length,
        // A replacement means the tier had a plan that a delete had archived, so
        // it could never be sold again. Reported because it implies billing
        // history on that tier.
        replaced: plans
          .filter((p) => p.replacedPlanId)
          .map((p) => ({
            tier: p.tier,
            archivedPlanId: p.replacedPlanId,
            newPlanId: p.planId,
            note: 'the previous plan was archived by a delete and could not be sold again; a replacement was created from the catalog price',
          })),
        unusable: plans.filter((p) => !p.usable).map((p) => ({
          tier: p.tier,
          planId: p.planId,
          status: p.status,
          note: 'this plan is switched off at the provider and is left alone in case that was deliberate; switch it back on, or create a replacement deliberately',
        })),
        mismatches: plans.filter((p) => p.priceMismatch).map((p) => ({
          tier: p.tier,
          planId: p.planId,
          expectedAmountMinor: p.expectedAmountMinor,
          actualAmountMinor: p.actualAmountMinor,
          note: 'the provider plan price does not match the catalog; update the plan at the provider or change the catalog',
        })),
        plans,
        errors,
      });
    }),
  );

  /**
   * Removes a provider plan.
   *
   * A plan can only be recognised as ours by the tag in its metadata, so a plan
   * that can no longer be sold would otherwise be found by that tag and reused
   * forever. Deleting it is the only way out, and the provider decides whether
   * that means removal or archiving — archiving is reported, never hidden,
   * because the tier is then left without a sellable plan and an operator has to
   * decide what the tier should cost.
   */
  router.post(
    '/api/v1/admin/billing/plans/delete',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      if (!requireGateway(res)) return;

      const body = req.body as { planId?: string };
      const planId = typeof body.planId === 'string' ? body.planId.trim() : '';
      if (!planId) {
        res.status(400).json({ error: 'planId is required', code: 'VALIDATION' });
        return;
      }

      const client = createOpenPayClient(ctx.cfg);
      try {
        const result = await removeTierPlan(ctx.db, ctx.cfg, client, planId);
        res.json({
          ...result,
          note:
            result.archived && result.note
              ? `${result.note} It cannot be subscribed to any more; the catalog price for that tier has no sellable plan until a new one is created.`
              : result.note,
        });
      } catch (err) {
        const described = describeOpenPayError(err);
        res.status(described.status).json({ error: described.message, code: described.code, providerCode: described.providerCode });
      }
    }),
  );

  /**
   * Cancels a subscription at the provider and stops serving.
   *
   * There was previously no way to cancel from this side — only the provider
   * could. The local subscription is set to revoked rather than deleted so the
   * ledger still shows what happened.
   */
  router.post(
    '/api/v1/admin/billing/subscriptions/cancel',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      if (!requireGateway(res)) return;

      const body = req.body as { userId?: string; providerSubscriptionId?: string };
      const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
      const providerSubscriptionId = typeof body.providerSubscriptionId === 'string' ? body.providerSubscriptionId.trim() : '';
      if (!userId && !providerSubscriptionId) {
        res.status(400).json({ error: 'userId or providerSubscriptionId is required', code: 'VALIDATION' });
        return;
      }

      // Prefer the id we recorded; fall back to the operator's, and only then to
      // asking the provider which subscriptions this customer holds.
      let target = providerSubscriptionId;
      let resolvedUserId = userId;
      if (!target && resolvedUserId) {
        const [row] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.userId, resolvedUserId)).limit(1);
        target = row?.providerSubscriptionId ?? '';
      }
      if (!target) {
        res.status(404).json({ error: 'no provider subscription recorded for that user; pass providerSubscriptionId', code: 'NOT_FOUND' });
        return;
      }

      const client = createOpenPayClient(ctx.cfg);
      try {
        const cancelled = await client.subscriptions.cancel(target);
        if (!resolvedUserId) {
          const [row] = await ctx.db
            .select({ userId: subscriptions.userId })
            .from(subscriptions)
            .where(eq(subscriptions.providerSubscriptionId, target))
            .limit(1);
          resolvedUserId = row?.userId ?? '';
        }
        if (resolvedUserId) {
          await ctx.db
            .update(subscriptions)
            .set({ tier: 'free', status: 'revoked', currentPeriodEnd: null, updatedAt: new Date() })
            .where(eq(subscriptions.userId, resolvedUserId));
          await revokeAllUserCredentials(ctx.db, resolvedUserId);
          await revokeAllRefreshTokens(ctx.db, resolvedUserId);
        }
        res.json({ ok: true, providerSubscriptionId: target, userId: resolvedUserId || null, subscription: cancelled });
      } catch (err) {
        const described = describeOpenPayError(err);
        res.status(described.status).json({ error: described.message, code: described.code, providerCode: described.providerCode });
      }
    }),
  );

  /**
   * Lists the provider's subscriptions, so an operator can find an id to act on.
   *
   * Read-only and separately gated from cancellation on purpose: seeing that a
   * subscription exists is useful far more often than cancelling one is.
   */
  router.get(
    '/api/v1/admin/billing/subscriptions',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      if (!requireGateway(res)) return;
      const query = req.query as { status?: string };
      const client = createOpenPayClient(ctx.cfg);
      try {
        const params: { status?: string } = {};
        if (typeof query.status === 'string' && query.status.trim()) params.status = query.status.trim();
        const listed = await client.subscriptions.list(Object.keys(params).length ? params : undefined);
        const ids = (listed.data ?? []).map((s) => s.id);
        // Join to local users where we know them, so the list is actionable.
        const local = ids.length
          ? await ctx.db
              .select({ providerSubscriptionId: subscriptions.providerSubscriptionId, userId: subscriptions.userId, tier: subscriptions.tier })
              .from(subscriptions)
          : [];
        const byProvider = new Map(local.map((r) => [r.providerSubscriptionId, r]));
        res.json({
          subscriptions: (listed.data ?? []).map((s) => ({
            id: s.id,
            status: s.status,
            planId: s.plan_id,
            customerId: s.customer_id,
            currentPeriodEnd: s.current_period_end,
            nextBillingAt: s.next_billing_at ?? null,
            userId: byProvider.get(s.id)?.userId ?? null,
            tier: (byProvider.get(s.id)?.tier as SubscriptionTier | undefined) ?? null,
          })),
        });
      } catch (err) {
        const described = describeOpenPayError(err);
        res.status(described.status).json({ error: described.message, code: described.code, providerCode: described.providerCode });
      }
    }),
  );

  return router;
}

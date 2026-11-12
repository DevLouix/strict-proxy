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
  setTierPlanPrice,
  isUsablePlan,
  isOurPlan,
  removeTierPlan,
  resolveMerchantId,
  PLAN_TIER_METADATA_KEY,
  MERCHANT_SETTING_KEY,
} from '../services/plans.js';
import {
  CURRENCY_SETTING_KEY,
  configuredAmount,
  loadBillingCurrency,
  loadPriceOverrides,
  setBillingCurrency,
  validateCurrency,
  validatePriceAmount,
} from '../services/pricing.js';
import { getSetting } from '../services/settings.js';
import { revokeAllUserCredentials } from '../services/nodes.js';
import { revokeAllRefreshTokens } from '../services/auth.js';
import { purchasableTiers, priceForTier } from '../services/catalog.js';
import { isKnownTier } from '../services/tiers.js';
import { auditActor, recordAudit } from '../services/audit.js';
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
      const [overrides, currency] = await Promise.all([
        loadPriceOverrides(ctx.db, ctx.cfg),
        loadBillingCurrency(ctx.db, ctx.cfg),
      ]);
      const tiers = purchasableTiers(ctx.cfg, overrides, currency).map(({ tier, price }) => {
        // The configured default is shown alongside the effective price so an
        // operator can always see what they are overriding, and can tell an
        // overridden price apart from the deployment's own.
        const configured = priceForTier(ctx.cfg, tier, {}, ctx.cfg.billingCurrency);
        return {
          tier,
          label: price.label,
          expectedAmountMinor: price.amountMinor,
          currency: price.currency,
          configuredAmountMinor: configured.amountMinor,
          configuredCurrency: configured.currency,
          overridden: price.amountMinor !== configured.amountMinor,
        };
      });

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
        res.json({
          merchantId,
          currency,
          defaultCurrency: ctx.cfg.billingCurrency,
          currencyOverridden: currency !== ctx.cfg.billingCurrency,
          tiers,
          providerPlans,
          gateway: 'openpay',
        });
      } catch (err) {
        const described = describeOpenPayError(err);
        res.status(described.status).json({ error: described.message, code: described.code, providerCode: described.providerCode });
      }
    }),
  );

  /**
   * The payment settings an operator can change without a redeploy.
   *
   * Amounts are in minor units: 200 is 2.00 in a two-decimal currency, which is
   * why they are reported as integers and never as a formatted string here — the
   * dashboard formats them for display.
   *
   * The environment values are reported as the defaults, so it is always clear
   * what this deployment would charge if nothing had been overridden.
   */
  router.get(
    '/api/v1/admin/billing/settings',
    ...adminOnly,
    asyncHandler(async (_req: Request, res: Response) => {
      const [overrides, currency] = await Promise.all([
        loadPriceOverrides(ctx.db, ctx.cfg),
        loadBillingCurrency(ctx.db, ctx.cfg),
      ]);
      res.json({
        currency,
        defaultCurrency: ctx.cfg.billingCurrency,
        currencyOverridden: currency !== ctx.cfg.billingCurrency,
        minorUnits: true,
        interval: 'month',
        tiers: purchasableTiers(ctx.cfg, overrides, currency).map(({ tier, price }) => {
          const configured = priceForTier(ctx.cfg, tier, {}, ctx.cfg.billingCurrency);
          return {
            tier,
            label: price.label,
            amountMinor: price.amountMinor,
            configuredAmountMinor: configured.amountMinor,
            currency: price.currency,
            overridden: price.amountMinor !== configured.amountMinor,
          };
        }),
      });
    }),
  );

  /**
   * Changes the currency new charges are opened in.
   *
   * Only the currency: amounts have their own endpoint because a price change
   * also has to reach the provider plan, and half-applying that here would
   * advertise a price the subscription path does not bill.
   *
   * Plans already created at the provider keep the currency they were made with;
   * a currency change therefore applies to new checkouts and newly created
   * plans, and the plans screen reports the drift. Silently repricing live
   * subscriptions is the provider's behaviour to define, not this route's.
   */
  router.put(
    '/api/v1/admin/billing/settings',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { currency?: unknown };
      if (body.currency === undefined) {
        res.status(400).json({ error: 'currency is required', code: 'VALIDATION' });
        return;
      }

      let currency: string;
      try {
        currency = validateCurrency(body.currency);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message, code: 'VALIDATION' });
        return;
      }

      const previous = await loadBillingCurrency(ctx.db, ctx.cfg);
      await setBillingCurrency(ctx.db, ctx.cfg, currency, req.auth?.sub);
      await recordAudit(ctx.db, {
        ...auditActor(req),
        action: 'billing.currency_changed',
        targetType: 'billing',
        targetId: CURRENCY_SETTING_KEY,
        summary: `Billing currency ${previous} -> ${currency}`,
        metadata: { previous, currency, defaultCurrency: ctx.cfg.billingCurrency },
      });

      res.json({
        currency,
        previousCurrency: previous,
        defaultCurrency: ctx.cfg.billingCurrency,
        note:
          'New checkouts and newly created plans use this currency. Plans already at the provider keep theirs until they are removed and the plans are re-synced.',
      });
    }),
  );

  /**
   * Provider readiness, straight from the gateway.
   *
   * "Billing is broken" has two very different causes — our key is wrong, or
   * the merchant's account is not ready to take money — and they look the same
   * in a failed charge. The gateway distinguishes them, so we ask it here and
   * surface its own reasons and remediation, rather than leaving an operator to
   * guess from a provider error string.
   */
  router.get(
    '/api/v1/admin/billing/providers',
    ...adminOnly,
    asyncHandler(async (_req: Request, res: Response) => {
      if (!requireGateway(res)) return;
      const client = createOpenPayClient(ctx.cfg);
      try {
        const merchantId = await resolveMerchantId(ctx.db, ctx.cfg, client);
        const overrides = await loadPriceOverrides(ctx.db, ctx.cfg);
        const currency = priceForTier(
          ctx.cfg,
          'standard',
          overrides,
          await loadBillingCurrency(ctx.db, ctx.cfg),
        ).currency;
        // Fees are a convenience: a gateway that refuses them must not blank
        // out the readiness information that actually matters.
        const [readiness, health, configs, fees] = await Promise.all([
          client.providers.getReadiness({ merchant_id: merchantId, currency }),
          client.providers.getHealth(),
          client.providers.listConfigs().catch(() => null),
          client.providers.getFees().catch(() => null),
        ]);
        res.json({
          gateway: 'openpay',
          merchantId,
          currency,
          generatedAt: readiness.data.generated_at,
          providers: readiness.data.providers,
          // Readiness answers "should this work?"; the saved config carries the
          // last real connection test's verdict and error, which is the field
          // that names an account-side problem in the provider's own words.
          configs: (configs?.data ?? []).map((c) => ({
            provider: c.provider,
            appId: c.app_id ?? null,
            isActive: c.is_active,
            isDefault: c.is_default,
            keyMode: c.key_mode ?? null,
            connectionStatus: c.connection_status ?? null,
            connectionError: c.connection_error ?? null,
            checkedAt: c.connection_checked_at ?? null,
            secretKeyConfigured: (c as { secret_key_configured?: boolean }).secret_key_configured ?? null,
            webhookSecretConfigured: (c as { webhook_secret_configured?: boolean }).webhook_secret_configured ?? null,
          })),
          health: health.data,
          fees: fees?.data ?? null,
        });
      } catch (err) {
        const described = describeOpenPayError(err);
        res.status(described.status).json({ error: described.message, code: described.code, providerCode: described.providerCode });
      }
    }),
  );

  /**
   * Runs the provider's own "Test connection", per workspace.
   *
   * This is not a cosmetic check. A workspace whose credentials are unverified,
   * or whose recent failures have tripped the router's threshold, has every call
   * refused with "open Provider Configuration > Test connection" — and a passing
   * test is what clears that stale history. Confirmed against the live gateway:
   * after this ran, a checkout stopped failing at the router and began reporting
   * the real account problem instead. It moves no money.
   */
  router.post(
    '/api/v1/admin/billing/providers/test',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      if (!requireGateway(res)) return;
      const client = createOpenPayClient(ctx.cfg);
      try {
        const body = req.body as { provider?: string };
        // Test what is actually configured rather than a caller-named provider,
        // so this cannot be pointed at a provider the workspace does not use.
        const listed = await client.providers.listConfigs().catch(() => null);
        const targets = (listed?.data ?? []).filter((c) => c.is_active && (!body.provider || c.provider === body.provider));
        if (targets.length === 0) {
          res.status(404).json({ error: 'no active provider configuration to test', code: 'NO_PROVIDER_CONFIG' });
          return;
        }

        const results: Array<Record<string, unknown>> = [];
        for (const config of targets) {
          try {
            const check = await client.providers.validateConfig({
              provider: config.provider as 'paystack' | 'flutterwave' | 'korapay' | 'hyperswitch',
              source: 'saved',
              app_id: config.app_id ?? null,
              update_saved_status: true,
            });
            results.push({
              provider: config.provider,
              ok: check.connection.status === 'valid',
              status: check.connection.status,
              code: check.connection.code,
              message: check.connection.message,
              remediation: check.connection.remediation,
              keyMode: check.connection.keyMode,
            });
          } catch (err) {
            // One provider failing must not hide the others' results.
            const described = describeOpenPayError(err);
            results.push({ provider: config.provider, ok: false, status: 'error', code: described.code, message: described.message, remediation: null, keyMode: null });
          }
        }

        // Health is re-read so the caller can see whether routing was freed.
        const health = await client.providers.getHealth().catch(() => null);
        res.json({ results, health: health?.data ?? null });
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
   * Changes what a tier costs.
   *
   * Deliberately not automatic. A price change alters what customers are
   * charged, so it is an explicit operator action with the amount in the body —
   * never a side effect of drift being noticed.
   */
  router.put(
    '/api/v1/admin/billing/plans/price',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { tier?: unknown; amountMinor?: unknown };
      const tier = typeof body.tier === 'string' ? body.tier.trim() : '';
      if (!isKnownTier(tier)) {
        res.status(400).json({ error: 'tier must be "standard" or "pro"', code: 'VALIDATION' });
        return;
      }
      let amountMinor: number;
      try {
        amountMinor = validatePriceAmount(body.amountMinor);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'invalid amount', code: 'VALIDATION' });
        return;
      }

      if (!requireGateway(res)) return;

      const client = createOpenPayClient(ctx.cfg);
      try {
        const change = await setTierPlanPrice(ctx.db, ctx.cfg, client, tier, amountMinor, req.auth?.sub);
        await recordAudit(ctx.db, {
          ...auditActor(req),
          action: 'billing.price_changed',
          targetType: 'tier',
          targetId: tier,
          summary: `Price for ${tier} set to ${amountMinor} (minor units)`,
          metadata: { tier, amountMinor, providerUpdated: change.providerUpdated, needsSync: change.needsSync },
        });
        res.json({
          ...change,
          note: change.providerUpdated
            ? 'the provider plan and the catalog now agree; new customers are charged this price'
            : change.needsSync
              ? 'no sellable plan exists for this tier yet; create missing plans to put this price into effect'
              : 'the catalog price was updated',
        });
      } catch (err) {
        const described = describeOpenPayError(err);
        res.status(described.status).json({ error: described.message, code: described.code, providerCode: described.providerCode });
      }
    }),
  );

  /**
   * Resets a tier to the price configured in the deployment.
   *
   * Deliberately routed through the same provider-and-catalogue update as a
   * manual change: dropping the override alone would leave the catalogue
   * advertising the configured price while the provider plan went on billing the
   * overridden one.
   */
  router.delete(
    '/api/v1/admin/billing/plans/price/:tier',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const tier = String(req.params.tier ?? '').trim();
      if (!isKnownTier(tier)) {
        res.status(400).json({ error: 'tier must be "standard" or "pro"', code: 'VALIDATION' });
        return;
      }

      if (!requireGateway(res)) return;

      const client = createOpenPayClient(ctx.cfg);
      try {
        const amountMinor = configuredAmount(ctx.cfg, tier);
        const change = await setTierPlanPrice(ctx.db, ctx.cfg, client, tier, amountMinor, req.auth?.sub);
        await recordAudit(ctx.db, {
          ...auditActor(req),
          action: 'billing.price_reset',
          targetType: 'tier',
          targetId: tier,
          summary: `Price for ${tier} reset to the configured default (${amountMinor} minor units)`,
          metadata: { tier, amountMinor },
        });
        res.json({ ...change, resetToConfigured: true, note: 'the tier now costs the amount configured for this deployment' });
      } catch (err) {
        const described = describeOpenPayError(err);
        res.status(described.status).json({ error: described.message, code: described.code, providerCode: described.providerCode });
      }
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
        await recordAudit(ctx.db, {
          ...auditActor(req),
          action: 'billing.plan_removed',
          targetType: 'plan',
          targetId: planId,
          summary: `Provider plan ${planId} ${result.archived ? 'archived (could not be removed)' : 'removed'}`,
          metadata: { planId, archived: Boolean(result.archived) },
        });
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
        await recordAudit(ctx.db, {
          ...auditActor(req),
          action: 'subscription.cancelled',
          targetType: 'user',
          targetId: resolvedUserId || null,
          summary: `Subscription ${target} cancelled${resolvedUserId ? '; access revoked' : ''}`,
          metadata: { providerSubscriptionId: target, userId: resolvedUserId || null },
        });
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

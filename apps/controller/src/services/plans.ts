/**
 * OpenPay plan provisioning.
 *
 * Recurring billing needs a provider-side plan per tier, and there is no plan in
 * `checkout.create` — a checkout is an amount, and a subscription is created
 * against a plan plus a tokenised payment method. So the plan has to exist
 * before a subscription can be started.
 *
 * Creating those plans by hand was the previous arrangement, which meant the
 * prices in `services/catalog.ts` and the prices the provider bills could drift
 * apart silently. This keeps them in step: plans are looked up by tier, created
 * when missing, and a price change is reported rather than pushed.
 *
 * The plan id per tier is cached in `platform_settings` so the common path is a
 * lookup, but the cache is only ever a hint — it is verified against the
 * provider before use, so a plan deleted or deactivated out of band is repaired
 * instead of silently reused.
 */
import type { OpenPayApi } from '@fiatden/openpay';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import type { SubscriptionTier } from '@strict-proxy/types';
import { getSetting, setSetting, deleteSetting } from './settings.js';
import { purchasableTierNames, priceForTier } from './catalog.js';
import {
  loadBillingCurrency,
  loadPriceOverrides,
  setPriceOverride,
  effectivePrice,
  validateCurrency,
} from './pricing.js';
import { httpStatusOf } from './openpay.js';

/** Where the provider plan id for a tier is cached. */
const PLAN_SETTING_PREFIX = 'openpay.plan.';

/** Operator override / cache for this deployment's merchant id. */
export const MERCHANT_SETTING_KEY = 'openpay.merchantId';

/**
 * Default trial on a newly created provider plan: none.
 *
 * A subscription is started only after the customer's first hosted checkout has
 * been paid and verified, so the first month is already covered. The provider
 * must not charge it again, but it also must not hand out free days: at
 * activation the plan's trial is set to exactly the time left in the paid
 * period (see `remainingPaidDays`), and it is zero here so a plan that is
 * created but never activated cannot be used as a free trial.
 */
export const RECURRING_TRIAL_DAYS = 0;

/** Marker written into plan metadata so a plan can be recognised as ours. */
export const PLAN_TIER_METADATA_KEY = 'strict_proxy_tier';

/** Marker so a plan we created can be found even if the cache is lost. */
const PLAN_SOURCE_METADATA_KEY = 'strict_proxy_source';

export interface TierPlan {
  tier: SubscriptionTier;
  planId: string;
  /** Price the catalog intends, in minor units. */
  expectedAmountMinor: number;
  /** Price the provider actually has. Differs when the plan was edited out of band. */
  actualAmountMinor: number;
  currency: string;
  interval: string;
  /** Provider-side free days before the first recurring charge. */
  trialDays: number;
  status: string;
  /**
   * Whether a subscription can actually be started against this plan.
   *
   * `false` for archived plans, which is what the provider substitutes for a
   * delete when the plan has subscriptions or plan-change history behind it —
   * the billing record survives, but the plan can no longer be sold. Surfacing
   * this matters: `status: 'archived'` otherwise looks like a plan we merely
   * failed to read.
   */
  usable: boolean;
  /** True when the provider's price does not match the catalog. */
  priceMismatch: boolean;
  /** True when this call created the plan. */
  created: boolean;
  /**
   * The dead plan this call replaced, if any.
   *
   * Set when the tier's tag was already attached to a plan that a delete had
   * archived: that plan can never be sold again, so a replacement is created —
   * but the operator is told, because it means the tier has a billing history
   * behind it.
   */
  replacedPlanId: string | null;
}

function settingKey(tier: SubscriptionTier): string {
  return `${PLAN_SETTING_PREFIX}${tier}`;
}

/**
 * Whether a provider plan can still be subscribed to.
 *
 * Archived plans are what a delete leaves behind when history references them.
 * `inactive` is included because a deactivated plan cannot be sold either — but
 * see {@link isReplaceablePlan} for why the two are not the same thing.
 */
export function isUsablePlan(plan: Record<string, unknown>): boolean {
  const status = String(plan['status'] ?? '').toLowerCase();
  return status !== 'archived' && status !== 'deleted' && status !== 'inactive';
}

/**
 * Whether a plan is dead weight that a replacement should be created for.
 *
 * Distinct from merely being unusable. `archived`/`deleted` are what the
 * provider leaves behind after a delete, so the plan is unreachable by design
 * and something must take its place. `inactive`, by contrast, is a plan someone
 * switched off deliberately — creating a second plan over it would override an
 * operator's decision, so it is reported and left alone.
 */
export function isReplaceablePlan(plan: Record<string, unknown>): boolean {
  const status = String(plan['status'] ?? '').toLowerCase();
  return status === 'archived' || status === 'deleted';
}

/** True when the provider's plan looks like one this platform created. */
export function isOurPlan(plan: { metadata?: Record<string, unknown> | null }): boolean {
  return plan.metadata?.[PLAN_SOURCE_METADATA_KEY] === 'strict-proxy';
}

/**
 * Finds the provider plan for a tier, or null.
 *
 * Looks in the cached id first, then scans the merchant's plans for one tagged
 * with the tier, so losing the cache does not create a duplicate plan.
 */
export async function findTierPlan(
  client: OpenPayApi,
  tier: SubscriptionTier,
  cachedId: string | null,
): Promise<{ plan: Record<string, unknown>; id: string } | null> {
  if (cachedId) {
    try {
      const plan = (await client.subscriptions.getPlan(cachedId)) as unknown as Record<string, unknown>;
      // Only trust the cache if it really is this tier's plan.
      if (isOurPlan(plan as { metadata?: Record<string, unknown> }) && (plan.metadata as Record<string, unknown>)?.[PLAN_TIER_METADATA_KEY] === tier) {
        return { plan, id: cachedId };
      }
    } catch (err) {
      // Deleted out of band: fall through and rebuild. Anything else is a real
      // failure and must propagate — treating a 500 as "gone" would create a
      // duplicate plan during a provider outage.
      if (httpStatusOf(err) !== 404) throw err;
    }
  }

  const listed = await client.subscriptions.listPlans();
  const ours = (listed.data ?? []).filter(
    (p) => isOurPlan(p as unknown as { metadata?: Record<string, unknown> }) && (p.metadata as Record<string, unknown> | undefined)?.[PLAN_TIER_METADATA_KEY] === tier,
  );
  // A tier can carry its tag on more than one plan: a delete that had to archive
  // leaves the dead plan's tag behind while a replacement is created. Prefer one
  // that can actually be subscribed to, so the choice does not depend on the
  // order the provider happens to list them in; fall back to the least dead.
  const pick = (p: unknown) => p as Record<string, unknown>;
  const match =
    ours.find((p) => isUsablePlan(pick(p))) ??
    ours.find((p) => !isReplaceablePlan(pick(p))) ??
    ours[0];
  if (!match) return null;
  return { plan: match as unknown as Record<string, unknown>, id: match.id };
}

/**
 * Resolves this deployment's merchant id.
 *
 * `createPlan` requires it and there is no "me" endpoint reachable with an API
 * key, so it has to be derived. `merchants.list` is *not* the answer: verified
 * live, it returns child/submerchant records under the account, not the calling
 * merchant. The app and plan records both carry the correct `merchant_id`, so
 * those are used, with an operator override for deployments where neither
 * exists yet.
 */
export async function resolveMerchantId(db: Db, cfg: ControllerConfig, client: OpenPayApi): Promise<string> {
  const override = await getSetting(db, cfg, MERCHANT_SETTING_KEY).catch(() => null);
  if (override) return override;

  // An app belongs to the calling merchant.
  const apps = await client.apps.list();
  const fromApp = apps.data?.[0]?.merchant_id;
  if (fromApp) {
    await setSetting(db, cfg, { key: MERCHANT_SETTING_KEY, value: fromApp });
    return fromApp;
  }

  // Any existing plan carries it too, which covers a deployment with no app.
  const plans = await client.subscriptions.listPlans();
  const fromPlan = plans.data?.[0]?.merchant_id;
  if (fromPlan) {
    await setSetting(db, cfg, { key: MERCHANT_SETTING_KEY, value: fromPlan });
    return fromPlan;
  }

  throw new Error(
    `could not determine the merchant id automatically. Set it with PUT /api/v1/admin/billing/plans {"merchantId":"..."} ` +
      `(it is the merchant_id on any app or plan record).`,
  );
}

/**
 * Returns the provider plan for a tier, creating it if it does not exist.
 *
 * Idempotent. Does not overwrite a provider plan whose price has drifted from
 * the catalog — that is reported as a mismatch, because silently repricing a
 * live plan changes what existing subscribers are billed.
 */
export async function ensureTierPlan(
  db: Db,
  cfg: ControllerConfig,
  client: OpenPayApi,
  tier: SubscriptionTier,
): Promise<TierPlan> {
  // The admin currency, not the configured one: a plan created in the deployment
  // default while the catalogue advertises another currency would bill customers
  // in a currency the price they were shown was not in.
  const currency = await loadBillingCurrency(db, cfg);
  const overrides = await loadPriceOverrides(db, cfg, currency);
  const price = priceForTier(cfg, tier, overrides, currency);
  const cachedId = await getSetting(db, cfg, settingKey(tier)).catch(() => null);

  const existing = await findTierPlan(client, tier, cachedId);
  if (existing) {
    const usable = isUsablePlan(existing.plan);
    // A plan that a delete archived can never be sold again, so the tier would be
    // stuck: the tag still matches, so it would be found and reused forever.
    // Replacing it is the only way out. A merely *deactivated* plan is different
    // — switching one off is an operator's decision, so it is respected and only
    // reported.
    const replaceable = isReplaceablePlan(existing.plan);
    if (usable || !replaceable) {
      await setSetting(db, cfg, { key: settingKey(tier), value: existing.id });
      return {
        tier,
        planId: existing.id,
        expectedAmountMinor: price.amountMinor,
        actualAmountMinor: Number(existing.plan['amount'] ?? 0),
        currency: String(existing.plan['currency'] ?? price.currency),
        interval: `${String(existing.plan['interval_count'] ?? 1)} ${String(existing.plan['interval_unit'] ?? 'month')}`,
        trialDays: Number(existing.plan['trial_days'] ?? 0),
        status: String(existing.plan['status'] ?? 'unknown'),
        usable,
        // A live plan is never silently repriced; the drift is reported instead.
        priceMismatch: Number(existing.plan['amount'] ?? 0) !== price.amountMinor,
        created: false,
        replacedPlanId: null,
      };
    }
  }

  const merchantId = await resolveMerchantId(db, cfg, client);
  const plan = (await client.subscriptions.createPlan({
    merchant_id: merchantId,
    name: `${cfg.openpayPlatformName} ${price.label} (${tier})`,
    description: `${price.label} subscription, ${cfg.openpayPlatformName}`,
    amount: price.amountMinor,
    currency: price.currency as never,
    interval_unit: 'month',
    interval_count: 1,
    trial_days: RECURRING_TRIAL_DAYS,
    // The SDK's `PlanCreateParams` omits `metadata`, but the API accepts it and
    // stores it (verified live: written on create, returned on read). Without it
    // a plan could only be recognised by name, which is not a safe key. Cast
    // rather than drop it, so the tag survives and plan discovery works.
    metadata: {
      [PLAN_TIER_METADATA_KEY]: tier,
      [PLAN_SOURCE_METADATA_KEY]: 'strict-proxy',
      label: price.label,
    },
  } as Parameters<OpenPayApi['subscriptions']['createPlan']>[0])) as unknown as Record<string, unknown>;

  const planId = String(plan['id']);
  await setSetting(db, cfg, { key: settingKey(tier), value: planId });

  return {
    tier,
    planId,
    expectedAmountMinor: price.amountMinor,
    actualAmountMinor: Number(plan['amount'] ?? price.amountMinor),
    currency: String(plan['currency'] ?? price.currency),
    interval: `${String(plan['interval_count'] ?? 1)} ${String(plan['interval_unit'] ?? 'month')}`,
    trialDays: Number(plan['trial_days'] ?? RECURRING_TRIAL_DAYS),
    status: String(plan['status'] ?? 'active'),
    usable: isUsablePlan(plan),
    priceMismatch: false,
    created: true,
    replacedPlanId: existing?.id ?? null,
  };
}

/**
 * Ensures a plan exists for every purchasable tier.
 *
 * Every tier is attempted even if one fails, so a single bad plan does not
 * leave the others unprovisioned.
 */
export async function syncTierPlans(
  db: Db,
  cfg: ControllerConfig,
  client: OpenPayApi,
): Promise<{ plans: TierPlan[]; errors: { tier: SubscriptionTier; error: string }[] }> {
  const plans: TierPlan[] = [];
  const errors: { tier: SubscriptionTier; error: string }[] = [];

  for (const tier of purchasableTierNames(cfg)) {
    try {
      plans.push(await ensureTierPlan(db, cfg, client, tier));
    } catch (err) {
      errors.push({ tier, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { plans, errors };
}

/** Records an operator-supplied merchant id, overriding the derived one. */
export async function setMerchantId(db: Db, cfg: ControllerConfig, merchantId: string): Promise<void> {
  await setSetting(db, cfg, { key: MERCHANT_SETTING_KEY, value: merchantId.trim() });
}

/** Drops a cached plan id so the next lookup rebuilds it. */
export async function forgetTierPlan(db: Db, cfg: ControllerConfig, tier: SubscriptionTier): Promise<void> {
  await deleteSetting(db, settingKey(tier));
}

/** What a price change did, and what is still outstanding. */
export interface TierPlanPriceChange {
  tier: SubscriptionTier;
  /** Price new checkouts charged before this change, in minor units. */
  previousAmountMinor: number;
  amountMinor: number;
  /** The plan at the provider that was repriced, if any. */
  planId: string | null;
  /** True when the provider plan's amount was actually changed. */
  providerUpdated: boolean;
  /**
   * True when the tier has no sellable plan, so the new price only takes effect
   * once a sync creates one.
   */
  needsSync: boolean;
}

/**
 * Changes what a tier costs, at the provider and in the catalog.
 *
 * Two things have to agree or customers get charged something other than the
 * advertised price: the catalogue amount (what a one-time checkout is opened
 * for) and the provider plan (what a subscription is billed against). Both are
 * changed here so they cannot drift as a result of this action.
 *
 * The provider is updated *first*. If that fails, the override is not written,
 * so a failed change leaves the deployment charging what it charged before
 * rather than advertising a price it cannot bill.
 *
 * NOTE: whether a provider subscription already in flight is repriced or keeps
 * its original amount is the provider's behaviour, not this code's, and it is
 * not verifiable from here while subscriptions cannot be created (the merchant's
 * settlement-provider key is rejected). Treat this as safe for *new* customers
 * and confirm the behaviour for existing ones with OpenPay before relying on it.
 */
export async function setTierPlanPrice(
  db: Db,
  cfg: ControllerConfig,
  client: OpenPayApi,
  tier: SubscriptionTier,
  amountMinor: number,
  updatedBy?: string,
  /** The currency the amount is expressed in; defaults to the deployment one. */
  currency: string = cfg.billingCurrency,
): Promise<TierPlanPriceChange> {
  const code = validateCurrency(currency);
  const overrides = await loadPriceOverrides(db, cfg, code);
  const previousAmountMinor = effectivePrice(cfg, overrides, tier, code);

  const cachedId = await getSetting(db, cfg, settingKey(tier)).catch(() => null);
  const existing = await findTierPlan(client, tier, cachedId);

  let planId: string | null = null;
  let providerUpdated = false;
  let needsSync = false;

  if (existing) {
    planId = existing.id;
    // An amount is only meaningful in its own currency: repricing a USD plan to
    // 300000 would charge $3,000.00 instead of the intended NGN 3,000.00, so a
    // currency change asks for a sync (which creates a plan in the new currency)
    // rather than rewriting the existing one.
    const planCurrency = String(existing.plan['currency'] ?? code).toUpperCase();
    if (isUsablePlan(existing.plan) && planCurrency === code) {
      await client.subscriptions.updatePlan(existing.id, { amount: amountMinor } as never);
      providerUpdated = true;
    } else {
      // Archived or switched off: it cannot be billed against, so the new price
      // only lands once a sync has produced a plan it can be sold from.
      needsSync = true;
    }
  } else {
    needsSync = true;
  }

  await setPriceOverride(db, cfg, tier, amountMinor, code, updatedBy);

  return { tier, previousAmountMinor, amountMinor, planId, providerUpdated, needsSync };
}

/** What happened to a plan that was removed. */
export interface TierPlanRemoval {
  planId: string;
  /** True when the plan was removed outright. */
  deleted: boolean;
  /**
   * True when the provider kept the plan as archived instead.
   *
   * That is not a failure: a plan with subscriptions or plan-change history
   * cannot be dropped without orphaning the billing record behind existing
   * charges, so the provider archives it. It cannot be sold afterwards, which is
   * why it is reported rather than treated as a clean delete.
   */
  archived: boolean;
  status: string;
  /** Tiers whose cached plan id pointed at this plan and were cleared. */
  forgottenTiers: SubscriptionTier[];
  /** The provider's own note, verbatim. */
  note: string;
}

/**
 * Removes a provider plan and drops any cache entry pointing at it.
 *
 * Needed because a plan can only be recognised as ours by its tag, so a stale
 * archive would otherwise be found and reused forever: the tag still matches, so
 * `findTierPlan` keeps returning a plan that cannot be subscribed to.
 *
 * A delete that the provider turns into an archive leaves the tier with no
 * usable plan, which the caller sees from `archived` — it is reported, not
 * papered over by silently creating a second plan under the same tag.
 */
export async function removeTierPlan(
  db: Db,
  cfg: ControllerConfig,
  client: OpenPayApi,
  planId: string,
): Promise<TierPlanRemoval> {
  const result = (await client.subscriptions.deletePlan(planId)) as unknown as {
    deleted?: boolean;
    archived?: boolean;
    plan?: Record<string, unknown>;
    note?: string;
  };

  // Clear the cache for any tier that was pointing at this plan, so the next
  // sync provisions rather than trusting an id that no longer can be sold.
  const forgottenTiers: SubscriptionTier[] = [];
  for (const tier of purchasableTierNames(cfg)) {
    const cached = await getSetting(db, cfg, settingKey(tier)).catch(() => null);
    if (cached === planId) {
      await forgetTierPlan(db, cfg, tier);
      forgottenTiers.push(tier);
    }
  }

  const archived = result.archived === true;
  const deleted = archived ? false : result.deleted !== false;
  return {
    planId,
    deleted,
    archived,
    status: String(result.plan?.['status'] ?? (deleted ? 'deleted' : 'unknown')),
    forgottenTiers,
    note: String(result.note ?? ''),
  };
}

/**
 * Recurring billing activation.
 *
 * The customer's first month is a hosted checkout, because that is the only
 * payment surface the mobile client can open. A one-off charge does not renew,
 * though: once the first payment is verified, the card saved by checkout is
 * turned into a provider subscription for the same tier.
 *
 * The subscription is started with a trial equal to the time left in the paid
 * period, so the provider neither bills the paid month twice nor gives away
 * days the customer has not bought. The first renewal is the normal monthly
 * charge when that period ends.
 *
 * Entitlement is not granted here. It is already granted by the verified
 * checkout webhook; this only attaches the renewal mechanism and stores the
 * provider subscription id so later `subscription.*` events can resolve the
 * user.
 */
import { eq } from 'drizzle-orm';
import type { OpenPayApi } from '@fiatden/openpay';
import type { SubscriptionTier } from '@strict-proxy/types';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import { subscriptions } from '../db/schema.js';
import { createOpenPayClient, isOpenPayConfigured } from './openpay.js';
import { ensureTierPlan } from './plans.js';
import { isKnownTier, remainingPaidDays } from './tiers.js';

export type RecurringUnavailableReason =
  | 'gateway_unconfigured'
  | 'not_paid'
  | 'already_active'
  | 'no_customer'
  | 'no_saved_card'
  | 'plan_not_sellable';

export interface RecurringActivation {
  activated: boolean;
  reason?: RecurringUnavailableReason;
  message?: string;
  tier?: SubscriptionTier;
  providerSubscriptionId?: string;
  /** Provider billing period end, when the provider returned one. */
  periodEnd?: string | null;
}

const PAID_TIERS: SubscriptionTier[] = ['standard', 'pro'];

/**
 * Turns the card saved by a settled checkout into a monthly subscription.
 *
 * Idempotent: a subscription already recorded for the account is returned as
 * active rather than created twice. Safe to call when the customer returns to
 * the app; provider calls use an idempotency key as well.
 */
export async function activateRecurringSubscription(
  db: Db,
  cfg: ControllerConfig,
  userId: string,
  client?: OpenPayApi,
): Promise<RecurringActivation> {
  if (!isOpenPayConfigured(cfg)) {
    return { activated: false, reason: 'gateway_unconfigured', message: 'Billing is not configured on this deployment.' };
  }

  const [row] = await db
    .select({
      tier: subscriptions.tier,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      providerCustomerId: subscriptions.providerCustomerId,
      providerSubscriptionId: subscriptions.providerSubscriptionId,
    })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  const tier = row && isKnownTier(row.tier) ? (row.tier as SubscriptionTier) : 'free';
  const periodLive = !row?.currentPeriodEnd || row.currentPeriodEnd.getTime() > Date.now();
  if (!row || !PAID_TIERS.includes(tier) || row.status !== 'active' || !periodLive) {
    return {
      activated: false,
      reason: 'not_paid',
      message: 'An active paid plan is required before auto-renew can be enabled.',
      tier,
    };
  }

  if (row.providerSubscriptionId) {
    return {
      activated: true,
      reason: 'already_active',
      tier,
      providerSubscriptionId: row.providerSubscriptionId,
      periodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    };
  }

  if (!row.providerCustomerId) {
    return {
      activated: false,
      reason: 'no_customer',
      message: 'The provider did not return a customer for the first payment. Contact support to enable auto-renew.',
      tier,
    };
  }

  const api = client ?? createOpenPayClient(cfg);
  const plan = await ensureTierPlan(db, cfg, api, tier);
  if (!plan.usable) {
    return {
      activated: false,
      reason: 'plan_not_sellable',
      message: `The ${tier} plan cannot be subscribed to at the provider. An operator needs to sync plans.`,
      tier,
    };
  }

  // The plan's trial is the remaining paid time, not a fixed period: setting
  // 30 days on the fifth day of a paid month added five free days.
  const trialDays = remainingPaidDays(row.currentPeriodEnd);
  if (plan.trialDays !== trialDays) {
    await api.subscriptions.updatePlan(plan.planId, { trial_days: trialDays } as never);
  }

  const methods = await api.customers.paymentMethods(row.providerCustomerId);
  const saved = methods.data ?? [];
  const card = saved.find((m) => m.reusable && m.is_default) ?? saved.find((m) => m.reusable) ?? saved[0];
  if (!card) {
    return {
      activated: false,
      reason: 'no_saved_card',
      message: 'No reusable card was saved with the first payment. Pay again with card saving enabled, or contact support.',
      tier,
    };
  }

  const created = await api.subscriptions.create({
    plan_id: plan.planId,
    customer_id: row.providerCustomerId,
    payment_method_id: card.id,
    metadata: { user_id: userId, tier, source: 'strict-proxy' },
    idempotency_key: `strictproxy:${userId}:${tier}:${plan.planId}`,
  });

  await db
    .update(subscriptions)
    .set({
      provider: 'openpay',
      providerSubscriptionId: created.id,
      providerCustomerId: row.providerCustomerId,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.userId, userId));

  return {
    activated: true,
    tier,
    providerSubscriptionId: created.id,
    periodEnd: created.current_period_end ?? null,
    // The entitlement period stays whatever the verified checkout granted;
    // renewal events extend it from here.
  };
}

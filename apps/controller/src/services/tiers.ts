/**
 * Subscription tier catalog + period helpers.
 * Single source of truth for seat limits and access rules.
 */
import type { SubscriptionTier, TierDefinition } from '@strict-proxy/types';

export const TIERS: Record<SubscriptionTier, TierDefinition> = {
  free: { tier: 'free', deviceSeats: 1, maxNodes: 2, bandwidthQuotaBytes: 10 * 1024 * 1024 * 1024 },
  standard: { tier: 'standard', deviceSeats: 3, maxNodes: 10, bandwidthQuotaBytes: null },
  pro: { tier: 'pro', deviceSeats: 5, maxNodes: 999, bandwidthQuotaBytes: null },
};

export function tierDefinition(tier: string): TierDefinition {
  return TIERS[(tier as SubscriptionTier) in TIERS ? (tier as SubscriptionTier) : 'free'];
}

export function isKnownTier(tier: string): tier is SubscriptionTier {
  return tier in TIERS;
}

/** Tier hierarchy used by gated links: pro includes everything standard has. */
export const TIER_RANK: Record<SubscriptionTier, number> = { free: 0, standard: 1, pro: 2 };

/** True when `actual` meets or exceeds the plan `required`. */
export function tierSatisfies(actual: SubscriptionTier, required: SubscriptionTier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[required];
}

/**
 * Tiers that entitle a customer to the tunnel.
 *
 * `free` is a row every account has so limits and status always have something
 * to read, but it grants no access: registration is not a trial. Everything
 * that serves credentials (the config bundle, entitlement tokens) checks this
 * list, not merely `status === 'active'`.
 */
export const PAID_TIERS: SubscriptionTier[] = ['standard', 'pro'];

export function isPaidTier(tier: string): tier is SubscriptionTier {
  return PAID_TIERS.includes(tier as SubscriptionTier);
}

/**
 * Days left in an already-paid period, for the provider plan's trial window.
 *
 * The first month is paid through a hosted checkout. When recurring billing is
 * attached afterwards, the provider must not charge that month again — so the
 * subscription starts with a trial exactly as long as the time the customer has
 * already paid for. Using a flat 30 days here handed out free days whenever the
 * card was attached late in the period.
 */
export function remainingPaidDays(periodEnd: Date | null, now: Date = new Date()): number {
  if (!periodEnd) return 0;
  const ms = periodEnd.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

/** Length of a billing period, in days. */
export const BILLING_PERIOD_DAYS = 30;

/** Default next period end when a payment event omits an explicit date. */
export function nextPeriodEnd(): Date {
  return new Date(Date.now() + BILLING_PERIOD_DAYS * 24 * 3600 * 1000);
}

/**
 * A period end one full billing period after `from`.
 *
 * Used for renewals. When the stored period has already elapsed the renewal
 * starts a fresh period rather than extending an expired one into the past.
 */
export function periodEndFrom(from: Date): Date {
  return new Date(from.getTime() + BILLING_PERIOD_DAYS * 24 * 3600 * 1000);
}

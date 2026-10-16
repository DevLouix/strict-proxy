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

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

/** Default next period end (30 days) when the webhook omits it. */
export function nextPeriodEnd(): Date {
  return new Date(Date.now() + 30 * 24 * 3600 * 1000);
}

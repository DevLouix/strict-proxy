/**
 * Billing catalog: maps subscription tiers to purchasable price points.
 *
 * Kept separate from `tiers.ts` (access rules) because prices are commercial
 * configuration while seats/node limits are platform policy.
 */
import type { SubscriptionTier, TierPrice } from '@strict-proxy/types';
import type { ControllerConfig } from '../env.js';
import { isKnownTier } from './tiers.js';

export class BillingError extends Error {
  constructor(
    readonly code: 'tier_not_purchasable' | 'unknown_tier',
    message: string,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

/**
 * Price points read from configuration, so an operator can change what a tier
 * costs without a deploy. `free` is never purchasable.
 */
export function priceCatalog(cfg: ControllerConfig): Record<SubscriptionTier, TierPrice | null> {
  return {
    free: null,
    standard: {
      amountMinor: cfg.billingStandardAmountMinor,
      currency: cfg.billingCurrency,
      label: 'Standard',
    },
    pro: {
      amountMinor: cfg.billingProAmountMinor,
      currency: cfg.billingCurrency,
      label: 'Pro',
    },
  };
}

/** Resolves a tier name to its price, rejecting unknown/unbuyable tiers. */
export function priceForTier(cfg: ControllerConfig, tier: string): TierPrice {
  if (!isKnownTier(tier)) {
    throw new BillingError('unknown_tier', `unknown tier "${tier}"`);
  }
  const price = priceCatalog(cfg)[tier];
  if (!price) {
    throw new BillingError('tier_not_purchasable', `the "${tier}" tier is not purchasable`);
  }
  return price;
}

/** Tiers that can actually be bought, cheapest first. */
export function purchasableTiers(cfg: ControllerConfig): Array<{ tier: SubscriptionTier; price: TierPrice }> {
  const catalog = priceCatalog(cfg);
  return (Object.keys(catalog) as SubscriptionTier[])
    .filter((tier) => catalog[tier] !== null)
    .map((tier) => ({ tier, price: catalog[tier]! }))
    .sort((a, b) => a.price.amountMinor - b.price.amountMinor);
}

/** Minor-unit amounts must be positive integers; reject nonsense config early. */
export function validateBillingConfig(cfg: ControllerConfig): void {
  for (const [tier, amount] of [
    ['standard', cfg.billingStandardAmountMinor],
    ['pro', cfg.billingProAmountMinor],
  ] as const) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BillingError('unknown_tier', `${tier} billing amount must be a positive integer (minor units)`);
    }
  }
  if (!/^[A-Z]{3}$/.test(cfg.billingCurrency)) {
    throw new BillingError('unknown_tier', `BILLING_CURRENCY must be a 3-letter ISO code, got "${cfg.billingCurrency}"`);
  }
}
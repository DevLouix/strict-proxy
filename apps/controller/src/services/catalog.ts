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
 * Operator-set price overrides, in minor units, keyed by tier.
 *
 * A stored override changes the *amount*; the currency comes from
 * `loadBillingCurrency` (admin setting, environment as the default) and is
 * passed in as one value, so a deployment cannot end up half priced in one
 * currency and half in another.
 */
export type PriceOverrides = Partial<Record<SubscriptionTier, number>>;

/**
 * Price points: the configured amount, unless an operator has overridden it.
 *
 * `overrides` is a required parameter on purpose. Every caller that charges or
 * displays a price must state where its numbers came from, so a call site that
 * forgets to load the overrides is a type error rather than a price that is
 * quietly wrong. `free` is never purchasable.
 */
export function priceCatalog(
  cfg: ControllerConfig,
  overrides: PriceOverrides,
  /** `loadBillingCurrency`: the admin setting, defaulting to the environment. */
  currency: string = cfg.billingCurrency,
): Record<SubscriptionTier, TierPrice | null> {
  return {
    free: null,
    standard: {
      amountMinor: overrides.standard ?? cfg.billingStandardAmountMinor,
      currency,
      label: 'Standard',
    },
    pro: {
      amountMinor: overrides.pro ?? cfg.billingProAmountMinor,
      currency,
      label: 'Pro',
    },
  };
}

/** Resolves a tier name to its price, rejecting unknown/unbuyable tiers. */
export function priceForTier(
  cfg: ControllerConfig,
  tier: string,
  overrides: PriceOverrides,
  currency: string = cfg.billingCurrency,
): TierPrice {
  if (!isKnownTier(tier)) {
    throw new BillingError('unknown_tier', `unknown tier "${tier}"`);
  }
  const price = priceCatalog(cfg, overrides, currency)[tier];
  if (!price) {
    throw new BillingError('tier_not_purchasable', `the "${tier}" tier is not purchasable`);
  }
  return price;
}

/** Tiers that can actually be bought, cheapest first. */
export function purchasableTiers(
  cfg: ControllerConfig,
  overrides: PriceOverrides,
  currency: string = cfg.billingCurrency,
): Array<{ tier: SubscriptionTier; price: TierPrice }> {
  const catalog = priceCatalog(cfg, overrides, currency);
  return (Object.keys(catalog) as SubscriptionTier[])
    .filter((tier) => catalog[tier] !== null)
    .map((tier) => ({ tier, price: catalog[tier]! }))
    .sort((a, b) => a.price.amountMinor - b.price.amountMinor);
}

/**
 * Which tiers are purchasable, without their prices.
 *
 * For callers that only need the set — sweeps and cache maintenance — so they do
 * not have to read price overrides they will not use.
 */
export function purchasableTierNames(cfg: ControllerConfig): SubscriptionTier[] {
  return purchasableTiers(cfg, {}).map((entry) => entry.tier);
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
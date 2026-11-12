/**
 * Operator-set price overrides.
 *
 * The catalogue amount for a tier comes from the environment, which means
 * changing what a tier costs used to need a redeploy. Overrides let an operator
 * change a price from the admin dashboard instead, while the environment stays
 * the default and the fallback.
 *
 * Overrides only carry the *amount*. The currency and which tiers are
 * purchasable remain deployment configuration, so an override cannot leave a
 * deployment half-priced in one currency and half in another.
 *
 * Setting a price here is only half of what a price change means: the provider
 * plan that subscriptions are actually billed against has to change too. That is
 * `plans.ts`'s job, and the route composes the two.
 */
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import type { SubscriptionTier } from '@strict-proxy/types';
import { getSetting, setSetting } from './settings.js';
import { BillingError, priceCatalog, priceForTier, purchasableTierNames, type PriceOverrides } from './catalog.js';

/** Where an override for a tier is stored. */
export const PRICE_SETTING_PREFIX = 'catalog.price.';

/**
 * Where the operator-set catalogue currency is stored.
 *
 * `BILLING_CURRENCY` stays the deployment default — an existing installation
 * keeps charging what it charged before — but the value in use is this setting,
 * so changing currency no longer needs a redeploy.
 */
export const CURRENCY_SETTING_KEY = 'catalog.currency';

/** Settings key holding the override for one tier. */
export function priceOverrideKey(tier: SubscriptionTier): string {
  return `${PRICE_SETTING_PREFIX}${tier}`;
}

/**
 * Reads the stored overrides.
 *
 * A malformed or non-positive stored value is ignored rather than thrown: a bad
 * row must not stop the whole pricing surface (and therefore checkout) from
 * working. It is not silently "corrected" either — the environment default is
 * used, which is what the deployment would charge with no override at all.
 */
export async function loadPriceOverrides(db: Db, cfg: ControllerConfig): Promise<PriceOverrides> {
  const overrides: PriceOverrides = {};
  for (const tier of purchasableTierNames(cfg)) {
    const raw = await getSetting(db, cfg, priceOverrideKey(tier)).catch(() => null);
    if (!raw) continue;
    const amount = parseStoredAmount(raw);
    if (amount !== null) overrides[tier] = amount;
  }
  return overrides;
}

/** Stored as JSON so the value is self-describing in the settings table. */
function parseStoredAmount(raw: string): number | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const amount = (parsed as { amountMinor?: unknown } | null)?.amountMinor;
    return typeof amount === 'number' && Number.isInteger(amount) && amount > 0 ? amount : null;
  } catch {
    return null;
  }
}

/**
 * Validates an amount an operator wants to charge.
 *
 * Minor units must be a positive integer, matching what `validateBillingConfig`
 * requires of the configured prices — a fractional kobo would be silently
 * truncated somewhere between here and the provider.
 */
export function validatePriceAmount(amountMinor: unknown): number {
  if (typeof amountMinor !== 'number' || !Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new BillingError('unknown_tier', 'amountMinor must be a positive integer in minor units (e.g. 200 = 2.00)');
  }
  return amountMinor;
}

/** Records an override, replacing the configured amount for that tier. */
export async function setPriceOverride(
  db: Db,
  cfg: ControllerConfig,
  tier: SubscriptionTier,
  amountMinor: number,
  updatedBy?: string,
): Promise<void> {
  if (!purchasableTierNames(cfg).includes(tier)) {
    throw new BillingError('tier_not_purchasable', `the "${tier}" tier is not purchasable in this deployment`);
  }
  await setSetting(
    db,
    cfg,
    { key: priceOverrideKey(tier), value: JSON.stringify({ amountMinor: validatePriceAmount(amountMinor) }) },
    updatedBy,
  );
}

/**
 * The configured amount for a tier, ignoring any override.
 *
 * Used by the reset path: a reset applies this through the same
 * provider-and-catalogue update as any other change, rather than deleting the
 * override. Deleting it would revert the catalogue to the configured price while
 * the provider plan kept billing the overridden one — the catalogue would then
 * advertise a price the subscription path does not charge.
 */
export function configuredAmount(cfg: ControllerConfig, tier: SubscriptionTier): number {
  return priceForTier(cfg, tier, {}).amountMinor;
}

/**
 * Validates an ISO 4217 code an operator wants to charge in.
 *
 * Three uppercase letters, matching what `validateBillingConfig` requires of the
 * configured default: the provider rejects anything else, and accepting it here
 * would fail at checkout instead of at the point of change.
 */
export function validateCurrency(code: unknown): string {
  const value = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new BillingError('unknown_tier', `currency must be a 3-letter ISO 4217 code (e.g. USD), got "${String(code)}"`);
  }
  return value;
}

/**
 * The currency prices are charged in: the admin setting, else the environment.
 *
 * A stored value that no longer validates is ignored rather than thrown, for the
 * same reason as a corrupted amount override: a bad row must not stop checkout.
 */
export async function loadBillingCurrency(db: Db, cfg: ControllerConfig): Promise<string> {
  const stored = await getSetting(db, cfg, CURRENCY_SETTING_KEY).catch(() => null);
  if (!stored) return cfg.billingCurrency;
  try {
    return validateCurrency(stored);
  } catch {
    return cfg.billingCurrency;
  }
}

/** Records the catalogue currency. Returns the validated value that was stored. */
export async function setBillingCurrency(
  db: Db,
  cfg: ControllerConfig,
  code: unknown,
  updatedBy?: string,
): Promise<string> {
  const currency = validateCurrency(code);
  await setSetting(db, cfg, { key: CURRENCY_SETTING_KEY, value: currency }, updatedBy);
  return currency;
}

/** The effective amount for a tier: the override if set, otherwise the env. */
export function effectivePrice(
  cfg: ControllerConfig,
  overrides: PriceOverrides,
  tier: SubscriptionTier,
  currency: string = cfg.billingCurrency,
): number {
  const fromOverride = overrides[tier];
  if (fromOverride !== undefined) return fromOverride;
  const price = priceCatalog(cfg, overrides, currency)[tier];
  if (!price) throw new BillingError('tier_not_purchasable', `the "${tier}" tier is not purchasable`);
  return price.amountMinor;
}

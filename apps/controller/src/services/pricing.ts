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
import { deleteSetting, getSetting, setSetting } from './settings.js';
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
 * Reads one tier's stored prices, keyed by ISO currency.
 *
 * Prices are per currency: 500 in USD and 300000 in NGN are both "the standard
 * price", and switching currency picks the amount that belongs to it instead of
 * reinterpreting the same number. Rows written before this existed hold a single
 * `amountMinor`, which can only have been in the deployment currency, so they are
 * read as that currency's entry.
 *
 * Malformed or non-positive entries are dropped rather than thrown: a bad row
 * must not stop the whole pricing surface (and therefore checkout) from working.
 */
function parseStoredAmounts(raw: string, legacyCurrency: string): Record<string, number> {
  const amounts: Record<string, number> = {};
  const accept = (code: unknown, value: unknown) => {
    if (typeof code !== 'string' || !/^[A-Z]{3}$/i.test(code)) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return;
    amounts[code.toUpperCase()] = value;
  };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return amounts;
    const record = parsed as { amountMinor?: unknown; amounts?: unknown };
    if (record.amounts && typeof record.amounts === 'object') {
      for (const [code, value] of Object.entries(record.amounts as Record<string, unknown>)) {
        accept(code, value);
      }
    }
    accept(legacyCurrency, record.amountMinor);
  } catch {
    // Not JSON: no usable price.
  }
  return amounts;
}

/**
 * The overrides that apply in `currency`.
 *
 * `currency` defaults to the deployment default so an older call site keeps its
 * behaviour, but every path that charges or displays a price passes the admin
 * currency explicitly.
 */
export async function loadPriceOverrides(
  db: Db,
  cfg: ControllerConfig,
  currency: string = cfg.billingCurrency,
): Promise<PriceOverrides> {
  const overrides: PriceOverrides = {};
  for (const tier of purchasableTierNames(cfg)) {
    const raw = await getSetting(db, cfg, priceOverrideKey(tier)).catch(() => null);
    if (!raw) continue;
    const amount = parseStoredAmounts(raw, cfg.billingCurrency)[currency];
    if (amount !== undefined) overrides[tier] = amount;
  }
  return overrides;
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

/**
 * Records the price for one tier in one currency.
 *
 * Other currencies for the same tier are preserved, so an operator can price a
 * tier in several currencies and switch between them without retyping amounts.
 */
export async function setPriceOverride(
  db: Db,
  cfg: ControllerConfig,
  tier: SubscriptionTier,
  amountMinor: number,
  currency: string = cfg.billingCurrency,
  updatedBy?: string,
): Promise<void> {
  if (!purchasableTierNames(cfg).includes(tier)) {
    throw new BillingError('tier_not_purchasable', `the "${tier}" tier is not purchasable in this deployment`);
  }
  const code = validateCurrency(currency);
  const amount = validatePriceAmount(amountMinor);

  const raw = await getSetting(db, cfg, priceOverrideKey(tier)).catch(() => null);
  const amounts = raw ? parseStoredAmounts(raw, cfg.billingCurrency) : {};
  amounts[code] = amount;

  await setSetting(
    db,
    cfg,
    { key: priceOverrideKey(tier), value: JSON.stringify({ amounts }) },
    updatedBy,
  );
}

/** Removes a tier's price for one currency, falling back to the configured amount. */
export async function clearPriceOverride(
  db: Db,
  cfg: ControllerConfig,
  tier: SubscriptionTier,
  currency: string = cfg.billingCurrency,
): Promise<void> {
  const code = validateCurrency(currency);
  const raw = await getSetting(db, cfg, priceOverrideKey(tier)).catch(() => null);
  const amounts = raw ? parseStoredAmounts(raw, cfg.billingCurrency) : {};
  if (amounts[code] === undefined) return;

  delete amounts[code];
  if (Object.keys(amounts).length === 0) {
    await deleteSetting(db, priceOverrideKey(tier));
    return;
  }
  await setSetting(db, cfg, { key: priceOverrideKey(tier), value: JSON.stringify({ amounts }) });
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

/**
 * Currencies the dashboard offers.
 *
 * A short list rather than every ISO code: these are the ones this platform's
 * gateways settle in, and a typo in a free-text field would be accepted by the
 * provider and then fail at checkout.
 */
export const CURRENCY_CHOICES = [
  'USD', 'EUR', 'GBP', 'NGN', 'KES', 'ZAR', 'GHS', 'CAD', 'AUD', 'INR', 'JPY', 'BRL', 'AED',
] as const;

/**
 * Symbols for the currencies above.
 *
 * Explicit rather than asked of `Intl`: Node ships with a trimmed ICU in some
 * builds, where `NGN` formats as "NGN" rather than "₦" — the dashboard would then
 * show a bare code where it promised a symbol. `Intl` still answers for anything
 * not listed here.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  NGN: '₦',
  KES: 'KSh',
  ZAR: 'R',
  GHS: '₵',
  CAD: 'CA$',
  AUD: 'A$',
  INR: '₹',
  JPY: '¥',
  BRL: 'R$',
  AED: 'د.إ',
};

/** The symbol for a currency, so the dashboard can show `USD ($)`. */
export function currencySymbol(code: string): string {
  const known = CURRENCY_SYMBOLS[code.toUpperCase()];
  if (known) return known;
  try {
    const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).formatToParts(0);
    return parts.find((part) => part.type === 'currency')?.value ?? code;
  } catch {
    return code;
  }
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

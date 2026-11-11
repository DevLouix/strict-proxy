/**
 * Billing orchestration: opens provider checkouts and records them locally.
 *
 * This module talks to the provider SDK. Webhook handling must never import
 * it — an inbound payment event must be processable even when outbound HTTP
 * configuration is wrong — so event->checkout resolution lives in
 * `checkout-resolution.ts` instead.
 *
 * Entitlement is never granted here. A checkout row records intent; only a
 * verified webhook (`applyPaymentEvent`) changes a subscription.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { billingCheckouts } from '../db/schema.js';
import type { BillingCheckoutPublic, SubscriptionTier } from '@strict-proxy/types';
import type { ControllerConfig } from '../env.js';
import type { OpenPayApi } from '@fiatden/openpay';
import { createOpenPayClient } from './openpay.js';
import { priceForTier } from './catalog.js';
import { loadPriceOverrides } from './pricing.js';

/** How long an unpaid checkout stays claimable. */
const CHECKOUT_TTL_MINUTES = 60;

/**
 * Opens a hosted checkout for `tier` and records it.
 *
 * `user_id` and `tier` are stamped into provider metadata so the webhook can
 * resolve the user directly; the local row is the durable fallback.
 */
export async function createTierCheckout(
  db: Db,
  cfg: ControllerConfig,
  params: {
    userId: string;
    email: string;
    tier: SubscriptionTier;
    successUrl?: string;
    cancelUrl?: string;
    /** OpenPay coupon code; validated by the provider at checkout time. */
    couponCode?: string;
  },
  /**
   * Injectable for tests, the same as `ensureTierPlan` takes its client. The
   * amount charged is the one thing here that must never be wrong, so it is
   * worth being able to assert against a stub instead of trusting the SDK call.
   */
  client?: OpenPayApi,
): Promise<BillingCheckoutPublic> {
  // Read the operator's price for this tier rather than the configured one: an
  // override set from the dashboard is what the customer must be charged.
  const overrides = await loadPriceOverrides(db, cfg);
  const price = priceForTier(cfg, params.tier, overrides);

  // Our own idempotent handle. The provider assigns its own `reference` on the
  // session, so both are persisted and either can match an inbound event.
  const reference = `spx-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + CHECKOUT_TTL_MINUTES * 60_000);

  const gateway = client ?? createOpenPayClient(cfg);
  const session = await gateway.checkout.create({
    amount: price.amountMinor,
    email: params.email,
    currency: price.currency,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    // The recurring subscription is started from this saved card once the
    // payment is verified; without it there is nothing to bill next month.
    save_card: true,
    ...(params.couponCode ? { coupon_code: params.couponCode } : {}),
    metadata: {
      user_id: params.userId,
      tier: params.tier,
      reference,
      source: 'strict-proxy',
      ...(params.couponCode ? { coupon_code: params.couponCode } : {}),
    },
    // Keeps a retried request from creating a second payable session.
    idempotency_key: reference,
  });

  await db.insert(billingCheckouts).values({
    userId: params.userId,
    reference,
    providerReference: session.reference ?? null,
    sessionId: session.session_id,
    tier: params.tier,
    amountMinor: price.amountMinor,
    currency: price.currency,
    status: 'open',
    expiresAt,
  });

  return {
    reference: session.reference ?? reference,
    checkoutUrl: session.checkout_url,
    couponCode: params.couponCode ?? null,
    tier: params.tier,
    amountMinor: price.amountMinor,
    currency: price.currency,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Marks abandoned checkouts as expired. Runs on the existing node sweep. */
export async function expireStaleCheckouts(db: Db): Promise<number> {
  const result = await db
    .update(billingCheckouts)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(and(eq(billingCheckouts.status, 'open'), sql`${billingCheckouts.expiresAt} < ${new Date()}`))
    .returning({ id: billingCheckouts.id });
  return result.length;
}

/** The user's most recent checkout, so the client can resume or show history. */
export async function latestCheckoutForUser(db: Db, userId: string) {
  const [row] = await db
    .select()
    .from(billingCheckouts)
    .where(eq(billingCheckouts.userId, userId))
    .limit(1)
    .orderBy(desc(billingCheckouts.createdAt));
  return row ?? null;
}
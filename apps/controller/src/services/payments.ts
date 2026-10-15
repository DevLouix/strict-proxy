/**
 * Payment gateway abstraction.
 *
 * `OpenPayAdapter` (services/openpay.ts) is the production implementation;
 * `PlaceholderPaymentAdapter` below is a development-only fallback used when no
 * gateway is configured.
 *
 * Integration contract:
 *   1. Implement `PaymentGatewayAdapter` (verifyWebhook + parseEvent).
 *   2. Pass it to `createPaymentWebhookRouter({ adapter })`, or configure
 *      OpenPay so one is selected automatically.
 *
 * The controller never calls the provider's API to decide entitlement; it
 * consumes only verified webhook events and applies them to subscription state.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { billingCheckouts, paymentEvents, subscriptions, users } from '../db/schema.js';
import { revokeAllRefreshTokens } from './auth.js';
import { revokeAllUserCredentials } from './nodes.js';
import { setNx } from '../redis.js';
import type { Redis } from 'ioredis';
import type { ControllerConfig } from '../env.js';
import { rateLimit } from './rate-limit.js';
import { findCheckoutForEvent, candidateReferences } from './checkout-resolution.js';
import { tierDefinition, nextPeriodEnd, isKnownTier } from './tiers.js';
import type { PaymentEvent, PaymentEventResult, PaymentEventType, SubscriptionTier } from '@strict-proxy/types';

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface PaymentGatewayAdapter {
  /** Provider discriminator stored on subscription rows. */
  readonly providerId: string;
  /**
   * Verifies the raw webhook request authenticity (signature header, IP
   * allowlist, etc.). Must return false for forged requests.
   */
  verifyWebhook(req: Request, cfg: ControllerConfig): boolean;
  /**
   * Parses a verified webhook request into our provider-agnostic event shape.
   * Return null for event types we don't care about.
   */
  parseEvent(req: Request): PaymentEvent | null;
}

/**
 * PLACEHOLDER ADAPTER — no external calls. Webhooks are authenticated with a
 * shared-secret HMAC over the raw body (`x-payment-signature: base64(HMAC-SHA256)`),
 * which is the common denominator of most gateways. Swap this out wholesale
 * when the real provider is integrated.
 */
export class PlaceholderPaymentAdapter implements PaymentGatewayAdapter {
  readonly providerId = 'placeholder';

  verifyWebhook(req: Request, cfg: ControllerConfig): boolean {
    const header = req.header('x-payment-signature');
    if (!header) return false;
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!raw) return false;
    const expected = createHmac('sha256', cfg.paymentWebhookSecret).update(raw).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(header, 'base64');
    } catch {
      return false;
    }
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  parseEvent(req: Request): PaymentEvent | null {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') return null;
    const id = typeof body['id'] === 'string' ? body['id'] : null;
    const type = typeof body['type'] === 'string' ? body['type'] : null;
    if (!id || !type) return null;

    const knownTypes: PaymentEventType[] = ['checkout.completed', 'subscription.deleted', 'invoice.payment_failed'];
    if (!knownTypes.includes(type as PaymentEventType)) return null;

    const data = (body['data'] ?? {}) as Record<string, unknown>;
    return {
      id,
      type: type as PaymentEventType,
      providerCustomerId: typeof data['customerId'] === 'string' ? data['customerId'] : null,
      providerSubscriptionId: typeof data['subscriptionId'] === 'string' ? data['subscriptionId'] : null,
      tier: typeof data['tier'] === 'string' ? (data['tier'] as SubscriptionTier) : null,
      currentPeriodEnd: typeof data['currentPeriodEnd'] === 'string' ? data['currentPeriodEnd'] : null,
      raw: body,
    };
  }
}

// ---------------------------------------------------------------------------
// Event application (idempotent, stateful)
// ---------------------------------------------------------------------------

/**
 * Finds the user a payment event concerns.
 *
 * Resolution order, most to least authoritative:
 *   1. `userId` carried in provider metadata (we stamp it on every checkout).
 *   2. A checkout row we opened whose reference matches the event — this is
 *      the durable link and survives providers that drop metadata.
 *   3. The subscription's stored provider customer/subscription id.
 *   4. An email that happens to match the customer reference.
 *
 * Every branch is a lookup against data we wrote; an event can never name an
 * arbitrary user because the id is matched, never trusted as a role claim.
 */
async function findUserIdByExternalRefs(
  db: Db,
  event: PaymentEvent,
): Promise<string | null> {
  if (event.userId) {
    const [byMeta] = await db.select({ id: users.id }).from(users).where(eq(users.id, event.userId)).limit(1);
    if (byMeta) return byMeta.id;
  }

  const byCheckout = await findCheckoutForEvent(db, event);
  if (byCheckout) return byCheckout.userId;

  const customerId = event.providerCustomerId;
  const subscriptionId = event.providerSubscriptionId;
  if (customerId) {
    const [row] = await db
      .select({ userId: subscriptions.userId })
      .from(subscriptions)
      .where(eq(subscriptions.providerCustomerId, customerId))
      .limit(1);
    if (row) return row.userId;
    // Fallback: some flows create the mapping on checkout via email metadata.
    const [byEmail] = await db.select({ id: users.id }).from(users).where(eq(users.email, customerId)).limit(1);
    if (byEmail) return byEmail.id;
  }
  if (subscriptionId) {
    const [row] = await db
      .select({ userId: subscriptions.userId })
      .from(subscriptions)
      .where(eq(subscriptions.providerSubscriptionId, subscriptionId))
      .limit(1);
    if (row) return row.userId;
  }
  return null;
}

/** Ensures a subscription row exists for the user. */
async function ensureSubscriptionRow(db: Db, userId: string): Promise<void> {
  await db.insert(subscriptions).values({ userId, tier: 'free', status: 'active' }).onConflictDoNothing({ target: subscriptions.userId });
}

async function markPaymentEvent(db: Db, eventId: string, applied: boolean, reason: string | null): Promise<void> {
  await db.update(paymentEvents).set({ applied, reason }).where(eq(paymentEvents.id, eventId));
}

/**
 * Applies a verified payment event. Idempotent via the payment_events ledger
 * plus a Redis fast-path for hot replays.
 */
export async function applyPaymentEvent(db: Db, redis: Redis, event: PaymentEvent): Promise<PaymentEventResult> {
  // Idempotency fast-path (Redis) + durable ledger (Postgres PK).
  const claimed = await setNx(redis, `payevt:${event.id}`, 60 * 60 * 24);
  if (!claimed) {
    return { applied: false, reason: 'duplicate_event' };
  }

  const [inserted] = await db
    .insert(paymentEvents)
    .values({ id: event.id, type: event.type, payload: event.raw as object })
    .onConflictDoNothing({ target: paymentEvents.id })
    .returning({ id: paymentEvents.id });
  if (!inserted) {
    return { applied: false, reason: 'duplicate_event' };
  }

  const userId = await findUserIdByExternalRefs(db, event);
  if (!userId) {
    await markPaymentEvent(db, event.id, false, 'unknown_customer');
    return { applied: false, reason: 'unknown_customer' };
  }

  await ensureSubscriptionRow(db, userId);

  switch (event.type) {
    case 'checkout.completed': {
      // -> Grants/extends the user's subscription tier.
      // Resolve the tier BEFORE settling the checkout: the ledger lookup only
      // matches open rows, so marking it paid first would hide the very row we
      // need to read the tier from.
      const tier = event.tier ?? (await tierForEvent(db, event));
      if (!tier || !isKnownTier(tier)) {
        await markPaymentEvent(db, event.id, false, 'unknown_event_type');
        return { applied: false, reason: 'unknown_event_type' };
      }
      // Settle the ledger so a replay cannot re-grant later, and so the admin
      // audit trail reflects what was actually paid for.
      await markCheckoutPaid(db, event);
      const parsedPeriodEnd = event.currentPeriodEnd ? new Date(event.currentPeriodEnd) : nextPeriodEnd();
      const periodEnd = Number.isNaN(parsedPeriodEnd.getTime()) ? nextPeriodEnd() : parsedPeriodEnd;
      await db
        .update(subscriptions)
        .set({
          tier,
          status: 'active',
          currentPeriodEnd: periodEnd,
          providerCustomerId: event.providerCustomerId,
          providerSubscriptionId: event.providerSubscriptionId,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.userId, userId));
      await markPaymentEvent(db, event.id, true, null);
      return { applied: true, userId, tier, tierExpiresAt: periodEnd.toISOString() };
    }

    case 'subscription.deleted':
    case 'invoice.payment_failed': {
      // -> Immediate revocation of node access.
      await db
        .update(subscriptions)
        .set({ tier: 'free', status: event.type === 'subscription.deleted' ? 'revoked' : 'expired', currentPeriodEnd: null, updatedAt: new Date() })
        .where(eq(subscriptions.userId, userId));
      await revokeAllUserCredentials(db, userId);
      await revokeAllRefreshTokens(db, userId);
      await markPaymentEvent(db, event.id, true, null);
      return { applied: true, userId, tier: 'free', tierExpiresAt: null };
    }

    default:
      await markPaymentEvent(db, event.id, false, 'unknown_event_type');
      return { applied: false, reason: 'unknown_event_type' };
  }
}

/**
 * Falls back to the tier recorded on the checkout row when the provider did
 * not echo our metadata back on the event.
 */
async function tierForEvent(db: Db, event: PaymentEvent): Promise<SubscriptionTier | null> {
  const checkout = await findCheckoutForEvent(db, event);
  if (!checkout) return null;
  return isKnownTier(checkout.tier) ? (checkout.tier as SubscriptionTier) : null;
}

/** Marks any matching checkout row as paid. Idempotent. */
async function markCheckoutPaid(db: Db, event: PaymentEvent): Promise<void> {
  const candidates = candidateReferences(event);
  if (candidates.length === 0) return;
  await db
    .update(billingCheckouts)
    .set({ status: 'paid', paidAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        or(inArray(billingCheckouts.reference, candidates), inArray(billingCheckouts.providerReference, candidates)),
        isNull(billingCheckouts.paidAt),
      ),
    );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createPaymentWebhookRouter(params: { db: Db; redis: Redis; cfg: ControllerConfig; adapter: PaymentGatewayAdapter }): Router {
  const router = Router();

  // Raw body is required for signature verification; express.json with
  // `verify` is wired in server.ts before this router is mounted.
  router.post(
    '/webhooks/payments',
    rateLimit(params.cfg, {
      bucket: 'webhooks.payments',
      maxAttempts: params.cfg.rateLimitMaxAttempts,
      windowSeconds: params.cfg.rateLimitWindowSeconds,
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!params.adapter.verifyWebhook(req, params.cfg)) {
          res.status(401).json({ error: 'invalid webhook signature', code: 'WEBHOOK_UNVERIFIED' });
          return;
        }
        const event = params.adapter.parseEvent(req);
        if (!event) {
          // Not an event we care about; ACK so the provider stops retrying.
          res.status(200).json({ received: true, ignored: true });
          return;
        }
        const result = await applyPaymentEvent(params.db, params.redis, event);
        res.status(200).json({ received: true, ...result });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

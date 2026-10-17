/**
 * Resolves an OpenPay payment event to the checkout row we created for it.
 * Split out of billing.ts so payments.ts can use it without pulling in the
 * provider SDK (webhook handling must not depend on outbound HTTP config).
 */
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { billingCheckouts } from '../db/schema.js';
import type { PaymentEvent } from '@strict-proxy/types';

/**
 * Extracts every reference-like identifier from an event payload that could be
 * our checkout reference: the top-level reference, and the nested charge /
 * session references. A provider may echo any of them.
 */
export function candidateReferences(event: PaymentEvent): string[] {
  const out = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0 && value.length <= 128) out.add(value);
  };

  const root = (event.raw ?? {}) as Record<string, unknown>;
  const data = (root['data'] ?? root['payload'] ?? root) as Record<string, unknown>;
  const object = (data['object'] ?? data) as Record<string, unknown>;

  push(root['reference']);
  push(root['id']);
  push(data['reference']);
  push(data['session_id']);
  push(data['charge_reference']);
  push(object['reference']);
  push(object['id']);
  push((object['metadata'] as Record<string, unknown> | undefined)?.['reference']);

  // A dispute is raised against an already-settled charge and names it by
  // `transaction_id`, which is the provider reference we stored. Without this
  // the lookup below could not connect the dispute to the purchase.
  push(object['transaction_id']);
  push(object['transactionId']);
  push(data['transaction_id']);

  return [...out];
}

/**
 * Finds the checkout this event settles, if we opened one.
 * Returns the matched row so callers can also settle the ledger entry.
 *
 * Only matches rows that have not been settled yet. That restriction is what
 * stops a replayed `charge.success` from re-granting a tier against a checkout
 * that is already paid — see {@link findChargeForEvent} for the settled case.
 */
export async function findCheckoutForEvent(
  db: Db,
  event: PaymentEvent,
): Promise<{ userId: string; tier: string; reference: string } | null> {
  const candidates = candidateReferences(event);
  if (candidates.length === 0) return null;

  const rows = await db
    .select({ userId: billingCheckouts.userId, tier: billingCheckouts.tier, reference: billingCheckouts.reference })
    .from(billingCheckouts)
    .where(
      and(
        or(
          inArray(billingCheckouts.reference, candidates),
          inArray(billingCheckouts.providerReference, candidates),
        ),
        or(eq(billingCheckouts.status, 'open'), isNull(billingCheckouts.status)),
      ),
    );

  if (rows.length > 0) return { userId: rows[0]!.userId, tier: rows[0]!.tier, reference: rows[0]!.reference };
  return null;
}

/**
 * Finds the settled purchase an event refers to, regardless of status.
 *
 * Needed for events that concern a charge *after* it settled — a dispute is the
 * case that matters. Restoring a wrongly-revoked subscription has to read the
 * tier off the checkout row, and by then that row is `paid`, so
 * {@link findCheckoutForEvent} deliberately will not return it.
 *
 * Prefers the most recently settled match, since a user may have transacted
 * more than once.
 */
export async function findChargeForEvent(
  db: Db,
  event: PaymentEvent,
): Promise<{ userId: string; tier: string; reference: string } | null> {
  const candidates = candidateReferences(event);
  if (candidates.length === 0) return null;

  const rows = await db
    .select({
      userId: billingCheckouts.userId,
      tier: billingCheckouts.tier,
      reference: billingCheckouts.reference,
      status: billingCheckouts.status,
      createdAt: billingCheckouts.createdAt,
    })
    .from(billingCheckouts)
    .where(
      or(
        inArray(billingCheckouts.reference, candidates),
        inArray(billingCheckouts.providerReference, candidates),
      ),
    )
    .orderBy(desc(billingCheckouts.createdAt));

  const settled = rows.find((r) => r.status === 'paid') ?? rows[0];
  if (!settled) return null;
  return { userId: settled.userId, tier: settled.tier, reference: settled.reference };
}

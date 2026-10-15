/**
 * Resolves an OpenPay payment event to the checkout row we created for it.
 * Split out of billing.ts so payments.ts can use it without pulling in the
 * provider SDK (webhook handling must not depend on outbound HTTP config).
 */
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
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

  return [...out];
}

/**
 * Finds the checkout this event settles, if we opened one.
 * Returns the matched row so callers can also settle the ledger entry.
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
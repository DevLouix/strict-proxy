/**
 * Bandwidth quota accounting.
 *
 * Nodes report per-credential usage windows into `usage_rollups`; this service
 * aggregates them per user so the tier catalogue's `bandwidthQuotaBytes` can be
 * enforced.
 *
 * Quotas are evaluated over a rolling window rather than the subscription's
 * calendar period: the controller does not persist a period-start timestamp,
 * and `nextPeriodEnd()` in the tier catalogue already defines a period as
 * 30 days, so a rolling 30-day window matches the rest of the platform.
 */
import { eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { nodeCredentials, usageRollups } from '../db/schema.js';

/** Length of the rolling window used to evaluate bandwidth quotas. */
export const QUOTA_WINDOW_DAYS = 30;

/** Start of the current quota window. */
export function quotaWindowStart(now = new Date()): Date {
  return new Date(now.getTime() - QUOTA_WINDOW_DAYS * 24 * 3600 * 1000);
}

/**
 * Total bytes (up + down) a user has consumed inside the quota window.
 * Reports are deduplicated by `(credential, windowStart, windowEnd)`, so
 * node retries cannot inflate this figure.
 */
export async function userBandwidthUsageInWindow(db: Db, userId: string, windowStart: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${usageRollups.bytesUp} + ${usageRollups.bytesDown}), 0)` })
    .from(usageRollups)
    .innerJoin(nodeCredentials, eq(nodeCredentials.id, usageRollups.credentialId))
    .where(sql`${nodeCredentials.userId} = ${userId} and ${usageRollups.windowStart} >= ${windowStart}`);

  const total = Number(row?.total ?? 0);
  return Number.isFinite(total) ? total : 0;
}
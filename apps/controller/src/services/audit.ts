/**
 * The operator audit trail.
 *
 * Every destructive admin action writes one row here: who did it (by id and by
 * email at the time), what was done, to which object, and a human-readable
 * summary. The email is stored separately because the user row can disappear
 * and the log has to outlive it.
 *
 * `recordAudit` never throws. An audit write that failed after a refund went
 * through must not turn the refund into an error the operator retries.
 */
import type { Request } from 'express';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { adminAuditLog } from '../db/schema.js';

export interface AuditEntry {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  summary: string;
  metadata?: Record<string, unknown> | null;
}

export interface AuditQuery {
  limit?: number;
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
}

/** The actor fields for a request, in the shape the log stores. */
export function auditActor(req: Request): { actorId: string | null; actorEmail: string | null } {
  return { actorId: req.auth?.sub ?? null, actorEmail: req.auth?.email ?? null };
}

/** Appends an audit row. Best effort: it logs a failure and returns. */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(adminAuditLog).values({
      actorId: entry.actorId ?? null,
      actorEmail: entry.actorEmail ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      summary: entry.summary,
      metadata: entry.metadata ?? null,
    });
  } catch (err) {
    console.error('[controller] audit write failed:', err);
  }
}

/** Newest-first operator actions, optionally narrowed to one object or action. */
export async function listAuditEntries(db: Db, query: AuditQuery = {}) {
  const conditions: SQL[] = [];
  if (query.action) conditions.push(eq(adminAuditLog.action, query.action));
  if (query.actorId) conditions.push(eq(adminAuditLog.actorId, query.actorId));
  if (query.targetType) conditions.push(eq(adminAuditLog.targetType, query.targetType));
  if (query.targetId) conditions.push(eq(adminAuditLog.targetId, query.targetId));

  const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 500);
  const base = db.select().from(adminAuditLog);
  const rows = await (conditions.length ? base.where(and(...conditions)) : base)
    .orderBy(desc(adminAuditLog.createdAt))
    .limit(limit);
  return rows;
}

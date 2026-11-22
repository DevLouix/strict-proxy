/**
 * The account's proxy sessions.
 *
 * A proxy credential is a bearer secret handed to a device: there is no way for
 * the controller to close a TCP connection the device already holds. Seats are
 * therefore enforced where they can be:
 *
 *   - one row per install, and the tier's `deviceSeats` bounds how many rows an
 *     account may hold — a fourth install on a three-seat plan displaces the
 *     least-recently-seen one;
 *   - issuing a config bundle revokes the node credentials of installs that
 *     hold no seat, so a node stops accepting them on its next sync. That
 *     happens there, after the entitlement checks, rather than on the claim: a
 *     device that cannot be given credentials (expired plan, exhausted quota)
 *     must not destroy the working credentials of a device that is connected;
 *   - the displaced client polls this table and shuts its own tunnel down.
 *
 * A shared credential cannot buy an extra seat. Seats are rows keyed by the
 * install id the controller issued the credential to, so handing a UUID to
 * someone else still occupies exactly one seat — and that seat's next bundle
 * fetch is what revokes the shared credential when the seat is displaced.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { vpnSessions } from '../db/schema.js';

export interface ActiveSession {
  sessionId: string;
  deviceId: string;
  startedAt: string;
  lastSeenAt: string;
}

export interface SessionClaim {
  sessionId: string;
  deviceId: string;
  startedAt: string;
  /** The install displaced to stay within the seats, when this claim caused it. */
  superseded: { deviceId: string; startedAt: string } | null;
  /** Installs holding a seat after this claim. */
  activeDevices: number;
  seatLimit: number;
}

function toActive(row: { sessionId: string; deviceId: string; startedAt: Date; lastSeenAt: Date }): ActiveSession {
  return {
    sessionId: row.sessionId,
    deviceId: row.deviceId,
    startedAt: row.startedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

/**
 * Every install currently holding a seat, least recently seen first.
 *
 * The order is the eviction order: the install that has gone longest without
 * claiming is the one a new device displaces.
 */
export async function listVpnSessions(db: Db, userId: string): Promise<ActiveSession[]> {
  const rows = await db.select().from(vpnSessions).where(eq(vpnSessions.userId, userId));
  return rows
    .map(toActive)
    .sort((a, b) => Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt) || a.deviceId.localeCompare(b.deviceId));
}

/**
 * Claims a seat for one install, evicting the least-recently-seen install when
 * the account is already at its seat limit.
 *
 * Re-claiming from the same install keeps its session id and start time, so an
 * ordinary reconnect does not churn credentials. The claimant's `lastSeenAt`
 * is stamped before the trim, which is what guarantees the claim never evicts
 * the install making it.
 */
export async function claimVpnSession(
  db: Db,
  params: { userId: string; deviceId: string; seatLimit: number },
): Promise<SessionClaim> {
  const seatLimit = Math.max(1, Math.floor(params.seatLimit));
  const now = new Date();
  const [existing] = await db
    .select()
    .from(vpnSessions)
    .where(and(eq(vpnSessions.userId, params.userId), eq(vpnSessions.deviceId, params.deviceId)))
    .limit(1);

  const sessionId = existing?.sessionId ?? randomBytes(18).toString('base64url');
  const startedAt = existing?.startedAt ?? now;

  await db
    .insert(vpnSessions)
    .values({ userId: params.userId, deviceId: params.deviceId, sessionId, startedAt, lastSeenAt: now })
    .onConflictDoUpdate({
      target: [vpnSessions.userId, vpnSessions.deviceId],
      set: { sessionId, lastSeenAt: now },
    });

  // Trim back to the plan's seats. The claimant was just stamped, so it sorts
  // newest and is never the row this removes.
  const all = await listVpnSessions(db, params.userId);
  const excess = Math.max(0, all.length - seatLimit);
  const evicted = all.slice(0, excess);
  if (evicted.length > 0) {
    await db
      .delete(vpnSessions)
      .where(
        and(
          eq(vpnSessions.userId, params.userId),
          inArray(
            vpnSessions.deviceId,
            evicted.map((row) => row.deviceId),
          ),
        ),
      );
  }

  return {
    sessionId,
    deviceId: params.deviceId,
    startedAt: startedAt.toISOString(),
    superseded: evicted[0] ? { deviceId: evicted[0].deviceId, startedAt: evicted[0].startedAt } : null,
    activeDevices: all.length - evicted.length,
    seatLimit,
  };
}

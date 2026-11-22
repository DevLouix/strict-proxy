/**
 * The account's single proxy session.
 *
 * A proxy credential is a bearer secret handed to a device: there is no way for
 * the controller to close a TCP connection the device already holds. "One
 * session per account" is therefore enforced where it can be:
 *
 *   - the row below records which install owns the account right now;
 *   - issuing a config bundle revokes every other install's node credentials,
 *     so a node stops accepting the previous device on its next sync. It
 *     deliberately happens there, after the entitlement checks, rather than on
 *     the claim: a device that cannot be given credentials (an expired plan,
 *     an exhausted quota) must not destroy the working credentials of the
 *     device that is already connected;
 *   - the losing client polls this row and shuts its own tunnel down, instead
 *     of sitting "connected" with credentials the node no longer accepts.
 *
 * The newest install to claim the session wins. Re-connecting from the same
 * install keeps its session id, so an ordinary reconnect does not churn node
 * credentials or disconnect anything.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { vpnSessions } from '../db/schema.js';

export interface SessionClaim {
  sessionId: string;
  deviceId: string;
  startedAt: string;
  /** The install this claim displaced, when a different device owned the slot. */
  superseded: { deviceId: string; startedAt: string } | null;
}

/** The session row currently owning the account, or null before the first claim. */
export async function currentVpnSession(db: Db, userId: string) {
  const [row] = await db
    .select()
    .from(vpnSessions)
    .where(eq(vpnSessions.userId, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Claims the account's proxy session for one install.
 *
 * Deliberately not in a transaction: the two devices racing to connect is
 * resolved by the unique user row (last upsert wins), and the revocation that
 * follows is idempotent. A transaction around the network-facing revocation
 * would only lengthen the window in which both devices look alive.
 */
export async function claimVpnSession(
  db: Db,
  params: { userId: string; deviceId: string },
): Promise<SessionClaim> {
  const [existing] = await db
    .select()
    .from(vpnSessions)
    .where(eq(vpnSessions.userId, params.userId))
    .limit(1);

  const now = new Date();
  const sameDevice = existing?.deviceId === params.deviceId;
  const sessionId = sameDevice && existing ? existing.sessionId : randomBytes(18).toString('base64url');
  const startedAt = sameDevice && existing ? existing.startedAt : now;

  await db
    .insert(vpnSessions)
    .values({
      userId: params.userId,
      deviceId: params.deviceId,
      sessionId,
      startedAt,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: vpnSessions.userId,
      set: { deviceId: params.deviceId, sessionId, startedAt, lastSeenAt: now },
    });

  // A different install took the slot. Its credentials are revoked when that
  // install is actually issued a bundle (see buildSignedConfigBundle), not
  // here: claiming alone proves intent, not entitlement, and revoking first
  // meant a 402/426 could disconnect a device that was working.
  const superseded = existing && !sameDevice ? existing : null;

  return {
    sessionId,
    deviceId: params.deviceId,
    startedAt: startedAt.toISOString(),
    superseded: superseded
      ? { deviceId: superseded.deviceId, startedAt: superseded.startedAt.toISOString() }
      : null,
  };
}

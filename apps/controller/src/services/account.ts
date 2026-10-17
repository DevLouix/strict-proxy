/**
 * Account recovery and self-service deletion.
 *
 * Without this, a user who forgets their password is locked out permanently:
 * there is no other way to prove identity. Reset tokens follow the same rules as
 * refresh tokens — only a hash is stored, they are single-use, and they expire.
 *
 * Delivery: an operator can issue a token for a user and hand it over out of
 * band, and the self-service endpoint accepts a `deliver` callback that the
 * configured mail transport plugs into. The endpoint never reveals whether an
 * address exists.
 */
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { passwordResetTokens, users } from '../db/schema.js';
import { revokeAllRefreshTokens } from './auth.js';
import { revokeAllUserCredentials } from './nodes.js';

/** How long a reset link stays usable. Deliberately short. */
export const RESET_TTL_MINUTES = 30;

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface IssuedReset {
  /** The raw token. Returned exactly once, to the issuer only. */
  token: string;
  expiresAt: Date;
}

/**
 * Issues a reset token for a user and revokes any outstanding ones, so only the
 * most recently issued link works.
 */
export async function issuePasswordReset(
  db: Db,
  userId: string,
  opts: { issuedBy?: string } = {},
): Promise<IssuedReset> {
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);

  await db.insert(passwordResetTokens).values({
    userId,
    tokenHash: sha256(token),
    expiresAt,
    issuedBy: opts.issuedBy ?? null,
  });

  return { token, expiresAt };
}

/** Finds the user a valid, unused, unexpired reset token belongs to. */
export async function userIdForResetToken(db: Db, token: string): Promise<string | null> {
  if (!token) return null;
  const hash = sha256(token);
  const [row] = await db
    .select({ userId: passwordResetTokens.userId })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.tokenHash, hash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}

/**
 * Consumes a reset token and sets a new password.
 *
 * Every other session is invalidated: someone who prompted the reset should not
 * leave an attacker holding a live refresh token. Returns the user id, or null
 * when the token is unknown, already used, or expired.
 */
export async function consumePasswordReset(
  db: Db,
  params: { token: string; passwordHash: string },
): Promise<string | null> {
  const userId = await userIdForResetToken(db, params.token);
  if (!userId) return null;

  const result = await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.tokenHash, sha256(params.token)), isNull(passwordResetTokens.usedAt)))
    .returning({ userId: passwordResetTokens.userId });
  // Lost the race against a concurrent reset with the same token.
  if (result.length === 0) return null;

  await db.update(users).set({ passwordHash: params.passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
  await revokeAllRefreshTokens(db, userId);
  await revokeAllUserCredentials(db, userId);
  return userId;
}

/** Discards outstanding reset tokens for a user. */
export async function clearPasswordResets(db: Db, userId: string): Promise<void> {
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
}

/**
 * Deletes an account and everything attached to it.
 *
 * Credentials and refresh tokens are revoked first so the deletion is not a
 * race: a node that has not yet synced must not keep serving a deleted user.
 * The rest cascades via foreign keys.
 */
export async function deleteAccount(db: Db, userId: string): Promise<boolean> {
  await revokeAllUserCredentials(db, userId);
  await revokeAllRefreshTokens(db, userId);

  const [deleted] = await db
    .delete(users)
    .where(eq(users.id, userId))
    .returning({ id: users.id });

  return deleted !== undefined;
}
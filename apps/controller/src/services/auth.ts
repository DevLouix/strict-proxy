/**
 * JWT access/refresh token issuance and verification, with device-seat
 * accounting. Refresh tokens are opaque random strings; only their SHA-256
 * is persisted.
 */
import { randomBytes, createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { devices, refreshTokens, revokedAccessTokens, users } from '../db/schema.js';
import type { ControllerConfig } from '../env.js';

export interface AccessClaims {
  sub: string;
  email: string;
  role: 'user' | 'admin';
  tier: string;
  jti: string;
  deviceId: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Issues a short-lived access token bound to a device. */
export function signAccessToken(cfg: ControllerConfig, claims: AccessClaims): string {
  return jwt.sign(claims, cfg.jwtSecret, {
    issuer: cfg.jwtIssuer,
    audience: 'strict-proxy-clients',
    expiresIn: cfg.accessTokenTtlSeconds,
    algorithm: 'HS256',
  });
}

/** Verifies an access token; throws on any invalidity. */
export function verifyAccessToken(cfg: ControllerConfig, token: string): AccessClaims {
  const decoded = jwt.verify(token, cfg.jwtSecret, {
    issuer: cfg.jwtIssuer,
    audience: 'strict-proxy-clients',
    algorithms: ['HS256'],
  });
  if (typeof decoded === 'string') throw new jwt.JsonWebTokenError('unexpected token type');
  return decoded as unknown as AccessClaims;
}

/** Checks the in-memory-of-DB revocation list (post-logout invalidation). */
export async function isAccessRevoked(db: Db, jti: string): Promise<boolean> {
  const rows = await db.select({ jti: revokedAccessTokens.jti }).from(revokedAccessTokens).where(eq(revokedAccessTokens.jti, jti)).limit(1);
  return rows.length > 0;
}

/** Records an access token as revoked until its natural expiry. */
export async function revokeAccessToken(db: Db, jti: string, expiresAt: Date): Promise<void> {
  await db.insert(revokedAccessTokens).values({ jti, expiresAt }).onConflictDoNothing();
}

/**
 * Issues a refresh token for (user, device). Enforces the tier's device-seat
 * limit by evicting the least-recently-seen device when over capacity.
 */
export async function issueRefreshToken(
  db: Db,
  cfg: ControllerConfig,
  params: { userId: string; deviceId: string; deviceName?: string; tier: string; seatLimit: number },
): Promise<string> {
  // Ensure the device row exists (and refresh its liveness stamp).
  const [deviceRow] = await db
    .insert(devices)
    .values({ userId: params.userId, deviceId: params.deviceId, deviceName: params.deviceName ?? null })
    .onConflictDoUpdate({
      target: [devices.userId, devices.deviceId],
      set: { lastSeenAt: new Date(), deviceName: params.deviceName ?? null },
    })
    .returning({ id: devices.id });

  if (!deviceRow) throw new Error('failed to upsert device');

  // Enforce seat limits: count distinct devices with a live refresh token.
  const activeDevices = await db
    .selectDistinct({ deviceRowId: refreshTokens.deviceRowId })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.userId, params.userId), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())));

  if (activeDevices.length >= params.seatLimit) {
    // Evict the stalest device(s) until we are within capacity.
    const evictable = await db
      .select({ deviceRowId: refreshTokens.deviceRowId, lastSeen: devices.lastSeenAt })
      .from(refreshTokens)
      .innerJoin(devices, eq(devices.id, refreshTokens.deviceRowId))
      .where(and(eq(refreshTokens.userId, params.userId), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())))
      .orderBy(devices.lastSeenAt);
    const excess = activeDevices.length - params.seatLimit + 1;
    const toEvict = evictable.slice(0, excess).map((r) => r.deviceRowId);
    if (toEvict.includes(deviceRow.id)) {
      // Re-authentication from an already active device should refresh its
      // token, not evict the device itself.
      const otherDevices = evictable.filter((r) => r.deviceRowId !== deviceRow.id);
      if (otherDevices.length < excess) throw new Error('device_seat_limit');
      toEvict.splice(0, toEvict.length, ...otherDevices.slice(0, excess).map((r) => r.deviceRowId));
    }
    for (const deviceRowId of toEvict) {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, params.userId), eq(refreshTokens.deviceRowId, deviceRowId), isNull(refreshTokens.revokedAt)));
    }
  }

  const raw = randomBytes(48).toString('base64url');
  await db.insert(refreshTokens).values({
    userId: params.userId,
    deviceRowId: deviceRow.id,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + cfg.refreshTokenTtlSeconds * 1000),
  });
  return raw;
}

/** Rotates a refresh token (single-use). Returns the owning user or null. */
export async function rotateRefreshToken(
  db: Db,
  cfg: ControllerConfig,
  rawToken: string,
): Promise<{ userId: string; deviceId: string } | null> {
  const tokenHash = sha256(rawToken);
  const [row] = await db
    .select({ id: refreshTokens.id, userId: refreshTokens.userId, deviceRowId: refreshTokens.deviceRowId, deviceId: devices.deviceId })
    .from(refreshTokens)
    .innerJoin(devices, eq(devices.id, refreshTokens.deviceRowId))
    .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())))
    .limit(1);
  if (!row) return null;

  // Single-use: revoke the presented token, caller issues a fresh pair.
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));

  // Opportunistic cleanup of long-dead tokens.
  await db.delete(refreshTokens).where(lt(refreshTokens.expiresAt, new Date(Date.now() - 7 * 24 * 3600 * 1000)));

  return { userId: row.userId, deviceId: row.deviceId };
}

/** Revokes every refresh token for a user (e.g. payment revocation path). */
export async function revokeAllRefreshTokens(db: Db, userId: string): Promise<void> {
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

/** Resolves a user's public record by id; null when missing. */
export async function findUserById(db: Db, userId: string) {
  const [row] = await db
    .select({ id: users.id, email: users.email, role: users.role, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

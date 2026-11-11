/**
 * Short-lived, Ed25519-signed entitlement tokens.
 *
 * A Gatekeeper-protected origin can verify these offline with the controller's
 * public key, so a plan check costs no round trip. The token is deliberately
 * short-lived and minted only from live subscription state: a cancelled account
 * keeps access for at most one token lifetime.
 */
import { signJson, loadSigningPrivateKey } from '@strict-proxy/types';
import type { EntitlementClaims, EntitlementTokenResponse, SubscriptionTier } from '@strict-proxy/types';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import { subscriptions, users } from '../db/schema.js';
import { isKnownTier } from './tiers.js';

/** Wire prefix, so a verifier can reject unrelated tokens immediately. */
export const ENTITLEMENT_TOKEN_PREFIX = 'sp1';

const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 900;

/** Clamps the configured lifetime into a range that is useful and revocable. */
export function entitlementTtlSeconds(cfg: ControllerConfig): number {
  const configured = Number.isFinite(cfg.entitlementTokenTtlSeconds) ? cfg.entitlementTokenTtlSeconds : 300;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.trunc(configured)));
}

/** Serializes claims and a canonical-JSON signature into the wire token. */
export function encodeEntitlementToken(claims: EntitlementClaims, signatureB64: string): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = Buffer.from(signatureB64, 'base64').toString('base64url');
  return `${ENTITLEMENT_TOKEN_PREFIX}.${payload}.${signature}`;
}

/**
 * Mints a token for a user from their current subscription row.
 *
 * The effective tier is `free` unless the row is active and its period has not
 * elapsed. A lapsed row that still says `standard` must not produce a standard
 * token; the Gatekeeper relies on that.
 */
export async function mintEntitlementToken(
  db: Db,
  cfg: ControllerConfig,
  userId: string,
): Promise<EntitlementTokenResponse> {
  const [row] = await db
    .select({
      email: users.email,
      tier: subscriptions.tier,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    })
    .from(users)
    .leftJoin(subscriptions, eq(subscriptions.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) throw new Error(`unknown user ${userId}`);

  const now = Date.now();
  const periodLive = !row.currentPeriodEnd || row.currentPeriodEnd.getTime() > now;
  const paidTier: SubscriptionTier =
    row.status === 'active' && periodLive && row.tier && isKnownTier(row.tier) ? (row.tier as SubscriptionTier) : 'free';
  const active = paidTier !== 'free' && periodLive;
  const ttl = entitlementTtlSeconds(cfg);
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttl * 1000).toISOString();

  const claims: EntitlementClaims = {
    version: 1,
    keyId: cfg.signingKeyId,
    sub: userId,
    email: row.email,
    tier: active ? paidTier : 'free',
    status: active ? 'active' : 'inactive',
    currentPeriodEnd: row.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
    issuedAt,
    expiresAt,
  };

  const signature = signJson(loadSigningPrivateKey(cfg.signingPrivateKeyPem), claims);
  return {
    token: encodeEntitlementToken(claims, signature),
    keyId: claims.keyId,
    tier: claims.tier,
    status: claims.status,
    expiresAt,
    currentPeriodEnd: claims.currentPeriodEnd,
  };
}

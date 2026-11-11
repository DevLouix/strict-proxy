/**
 * Unit checks for the Gatekeeper plan hierarchy and token verification.
 *
 * The end-to-end behaviour lives in gatekeeper.e2e.test.ts; this pins the pure
 * rules: pro includes standard, standard does not include pro, and a token
 * signed by the wrong key is never accepted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateEd25519Keypair, loadSigningPrivateKey, signJson } from '@strict-proxy/types';
import type { EntitlementClaims } from '@strict-proxy/types';
import { tierSatisfies, verifyEntitlementToken, TIER_RANK } from '@strict-proxy/gatekeeper';

const keys = generateEd25519Keypair();

function tokenFor(overrides: Partial<EntitlementClaims> = {}): string {
  const now = Date.now();
  const claims: EntitlementClaims = {
    version: 1,
    keyId: 'primary',
    sub: 'user-1',
    email: 'user@example.test',
    tier: 'standard',
    status: 'active',
    currentPeriodEnd: new Date(now + 30 * 24 * 3600 * 1000).toISOString(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300_000).toISOString(),
    ...overrides,
  };
  const signature = signJson(loadSigningPrivateKey(keys.privateKeyPem), claims);
  return `sp1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${Buffer.from(signature, 'base64').toString('base64url')}`;
}

test('pro includes standard and standard does not include pro', () => {
  assert.equal(TIER_RANK.pro > TIER_RANK.standard, true);
  assert.equal(tierSatisfies('pro', 'standard'), true);
  assert.equal(tierSatisfies('standard', 'standard'), true);
  assert.equal(tierSatisfies('standard', 'pro'), false);
  assert.equal(tierSatisfies('free', 'standard'), false);
});

test('a valid token verifies and exposes the identity', () => {
  const result = verifyEntitlementToken(tokenFor(), { primary: keys.publicKeyPem });
  assert.equal(result.ok, true);
  assert.equal(result.entitlement?.tier, 'standard');
  assert.equal(result.entitlement?.userId, 'user-1');
});

test('a token signed by another key is rejected', () => {
  const attacker = generateEd25519Keypair();
  assert.equal(verifyEntitlementToken(tokenFor(), { primary: attacker.publicKeyPem }).reason, 'bad_signature');
});

test('an unknown key id is rejected rather than falling back', () => {
  assert.equal(verifyEntitlementToken(tokenFor(), { other: keys.publicKeyPem }).reason, 'unknown_key');
});

test('an expired token is rejected', () => {
  const expired = tokenFor({ expiresAt: new Date(Date.now() - 120_000).toISOString() });
  assert.equal(verifyEntitlementToken(expired, { primary: keys.publicKeyPem }).reason, 'expired');
});

test('a malformed token is rejected without throwing', () => {
  for (const bad of ['', 'sp1', 'sp1.%%%.%%%', 'not-a-token']) {
    const result = verifyEntitlementToken(bad, { primary: keys.publicKeyPem });
    assert.equal(result.ok, false, bad);
  }
});

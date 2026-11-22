/**
 * Unit tests for the Gatekeeper Key Factory pure helpers (key generation,
 * SHA-256 hashing, format validation, and input normalization).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateGatekeeperKey,
  hashGatekeeperKey,
  isGatekeeperKeyFormat,
  isGatekeeperKeyPrefix,
  normalizeGatekeeperKeyInput,
  normalizeGatekeeperKeyUpdate,
  normalizeSiteUrl,
  sanitizeReturnPath,
  serializeGatekeeperKey,
} from '../../apps/controller/src/services/gatekeeper-keys.js';

test('generateGatekeeperKey produces unique high-entropy sp_gk_ secrets with matching SHA-256 hash', () => {
  const a = generateGatekeeperKey();
  const b = generateGatekeeperKey();

  assert.notEqual(a.rawKey, b.rawKey);
  assert.notEqual(a.keyHash, b.keyHash);
  assert.ok(a.rawKey.startsWith('sp_gk_'));
  assert.ok(a.rawKey.startsWith(`${a.keyPrefix}_`));
  assert.equal(isGatekeeperKeyFormat(a.rawKey), true);
  assert.equal(hashGatekeeperKey(a.rawKey), a.keyHash);
  assert.equal(a.keyHash.length, 64);
});

test('isGatekeeperKeyFormat rejects malformed keys and node public keys', () => {
  assert.equal(isGatekeeperKeyFormat(''), false);
  assert.equal(isGatekeeperKeyFormat('sp_gk_short'), false);
  assert.equal(isGatekeeperKeyFormat('dGVzdC1ub2RlLXB1YmxpYy1rZXk='), false);
  assert.equal(isGatekeeperKeyFormat('sp_gk_deadbeef_short'), false);
});

test('normalizeGatekeeperKeyInput validates name, note, and expiry', () => {
  assert.throws(() => normalizeGatekeeperKeyInput({}), /name is required/);
  assert.throws(() => normalizeGatekeeperKeyInput({ name: '   ' }), /name is required/);
  assert.throws(() => normalizeGatekeeperKeyInput({ name: 'x'.repeat(81) }), /80 characters/);
  assert.throws(() => normalizeGatekeeperKeyInput({ name: 'Site', expiresInDays: -5 }), /expiresInDays/);
  assert.throws(
    () => normalizeGatekeeperKeyInput({ name: 'Site', expiresAt: '2000-01-01T00:00:00Z' }, Date.now()),
    /future timestamp/,
  );

  const now = Date.UTC(2026, 5, 1, 0, 0, 0);
  const ok = normalizeGatekeeperKeyInput(
    { name: '  Partner Portal  ', note: '  https://partner.example.com  ', expiresInDays: 30 },
    now,
  );
  assert.equal(ok.name, 'Partner Portal');
  assert.equal(ok.note, 'https://partner.example.com');
  assert.equal(ok.expiresAt?.toISOString(), new Date(now + 30 * 86_400_000).toISOString());
});

test('serializeGatekeeperKey computes active, revoked, and expired status cleanly', () => {
  const base = {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Portal',
    keyPrefix: 'sp_gk_deadbeef',
    keyHash: 'a'.repeat(64),
    siteUrl: null as string | null,
    note: null,
    active: true,
    lastUsedAt: null,
    lastUsedIp: null,
    expiresAt: null as Date | null,
    revokedAt: null as Date | null,
    createdBy: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  assert.equal(serializeGatekeeperKey(base).status, 'active');
  assert.equal('keyHash' in serializeGatekeeperKey(base), false);

  const expired = serializeGatekeeperKey(
    { ...base, expiresAt: new Date('2026-01-02T00:00:00Z') },
    Date.parse('2026-01-03T00:00:00Z'),
  );
  assert.equal(expired.status, 'expired');
  assert.equal(expired.active, false);

  const revoked = serializeGatekeeperKey({
    ...base,
    active: false,
    revokedAt: new Date('2026-01-02T00:00:00Z'),
  });
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.active, false);
});

test('normalizeSiteUrl, sanitizeReturnPath, isGatekeeperKeyPrefix, and normalizeGatekeeperKeyUpdate', () => {
  assert.equal(normalizeSiteUrl('https://portal.example.com/dashboard?x=1'), 'https://portal.example.com');
  assert.equal(normalizeSiteUrl('http://localhost:3000/app'), 'http://localhost:3000');
  assert.equal(normalizeSiteUrl(''), null);
  assert.equal(normalizeSiteUrl(null), null);
  assert.throws(() => normalizeSiteUrl('http://portal.example.com'), /https:\/\//);
  assert.throws(() => normalizeSiteUrl('https://user:pass@portal.example.com'), /credentials/);
  assert.throws(() => normalizeSiteUrl('not-a-url'), /valid .*URL/);

  assert.equal(sanitizeReturnPath('/wallet?tab=1&sp_ticket=old'), '/wallet?tab=1');
  assert.equal(sanitizeReturnPath('//evil.example/pwn'), '/');
  assert.equal(sanitizeReturnPath('https://evil.example/pwn'), '/');
  assert.equal(sanitizeReturnPath('/\\evil.example'), '/');
  assert.equal(sanitizeReturnPath('/foo\r\nbar'), '/');

  assert.equal(isGatekeeperKeyPrefix('sp_gk_deadbeef'), true);
  assert.equal(isGatekeeperKeyPrefix('sp_gk_DEADBEEF'), false);
  assert.equal(isGatekeeperKeyPrefix('sp_gk_deadbeef_secret'), false);

  const upd = normalizeGatekeeperKeyUpdate({
    name: '  Updated Portal  ',
    siteUrl: 'https://updated.example.com/home',
    note: '  ops  ',
  });
  assert.equal(upd.name, 'Updated Portal');
  assert.equal(upd.siteUrl, 'https://updated.example.com');
  assert.equal(upd.note, 'ops');
});

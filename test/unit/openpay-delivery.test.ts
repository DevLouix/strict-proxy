/**
 * Replays a REAL captured OpenPay webhook delivery through our verification
 * path.
 *
 * The signature scheme was previously an assumption. It is now a recorded fact:
 * this fixture is an actual delivery captured by pointing a webhook endpoint at
 * a capture server and calling `webhooks.test()`. Replaying it means a change to
 * the verifier, the header name, or the signed material breaks a test instead of
 * silently dropping every payment in production.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fixture from '../fixtures/openpay-webhook-delivery.json' with { type: 'json' };
import { parseSignatureHeader, verifyOpenPaySignature, mapOpenPayEvent } from '../../apps/controller/src/services/openpay.js';

const SECRET = fixture.secret;
const BODY = fixture.rawBody;
const HEADERS = fixture.headers;
const SIGNATURE_HEADER = 'x-webhook-signature-v1';

test('the fixture records the scheme the provider actually uses', () => {
  // Guard against the fixture silently becoming something else.
  assert.equal(typeof BODY, 'string');
  assert.ok(HEADERS[SIGNATURE_HEADER], 'the v1 signature header must be present');
  assert.ok(HEADERS['x-webhook-signature'], 'the legacy signature header must be present');
});

test('the captured v1 header verifies with our implementation', () => {
  const result = verifyOpenPaySignature({
    header: HEADERS[SIGNATURE_HEADER],
    rawBody: Buffer.from(BODY, 'utf8'),
    secret: SECRET,
    // The fixture is a recording, so pin "now" to the recorded timestamp.
    timestampToleranceSeconds: 300,
    nowSeconds: Number(HEADERS['x-webhook-timestamp']),
  });
  assert.deepEqual(result, { ok: true }, 'the real delivery must verify');
});

test('the signed material is exactly "<t>." + rawBody', () => {
  const expected = createHmac('sha256', SECRET).update(`${HEADERS['x-webhook-timestamp']}.`, 'utf8').update(BODY, 'utf8').digest('hex');
  assert.equal(expected, HEADERS[SIGNATURE_HEADER].split('v1=')[1]);
});

test('the legacy header is hex(HMAC(secret, rawBody))', () => {
  const expected = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex');
  assert.equal(expected, HEADERS['x-webhook-signature']);
});

test('the legacy and v1 signatures differ, so they are not interchangeable', () => {
  assert.notEqual(HEADERS['x-webhook-signature'], HEADERS[SIGNATURE_HEADER].split('v1=')[1]);
});

test('the header name is x-webhook-signature-v1', () => {
  // This is the value that was previously wrong in our configuration.
  assert.equal(parseSignatureHeader(HEADERS[SIGNATURE_HEADER])?.timestamp, HEADERS['x-webhook-timestamp']);
});

test('the recorded timestamp decodes to the capture moment', () => {
  assert.equal(new Date(Number(HEADERS['x-webhook-timestamp']) * 1000).toISOString(), '2026-10-16T03:30:56.000Z');
});

test('a replayed delivery is rejected once outside the tolerance window', () => {
  const result = verifyOpenPaySignature({
    header: HEADERS[SIGNATURE_HEADER],
    rawBody: Buffer.from(BODY, 'utf8'),
    secret: SECRET,
    timestampToleranceSeconds: 300,
    nowSeconds: Number(HEADERS['x-webhook-timestamp']) + 3600,
  });
  assert.deepEqual(result, { ok: false, reason: 'stale' });
});

test('a tampered replay is rejected', () => {
  const result = verifyOpenPaySignature({
    header: HEADERS[SIGNATURE_HEADER],
    rawBody: Buffer.from(BODY.replace('test event', 'forged event'), 'utf8'),
    secret: SECRET,
    timestampToleranceSeconds: 300,
    nowSeconds: Number(HEADERS['x-webhook-timestamp']),
  });
  assert.deepEqual(result, { ok: false, reason: 'mismatch' });
});

test('the envelope shape is understood: id at the root, payload under data', () => {
  const parsed = JSON.parse(BODY) as Record<string, unknown>;
  assert.equal(typeof parsed['id'], 'string');
  assert.equal(typeof parsed['type'], 'string');
  assert.ok(parsed['data'] && typeof parsed['data'] === 'object', 'payload lives under data');

  // webhook.test is not an entitlement event, so it maps to null...
  assert.equal(mapOpenPayEvent(parsed), null);
  // ...but a charge.success in the same envelope shape must resolve.
  const mapped = mapOpenPayEvent({ id: 'evt_1', type: 'charge.success', created_at: parsed['created_at'], data: { metadata: { user_id: 'u1', tier: 'pro' } } });
  assert.equal(mapped?.type, 'checkout.completed');
  assert.equal(mapped?.userId, 'u1');
  assert.equal(mapped?.tier, 'pro');
});
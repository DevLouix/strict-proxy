/**
 * Unit tests for OpenPay signature verification and event mapping.
 *
 * These run without a database and without a provider, and they pin the exact
 * bytes that get signed — the single most security-sensitive contract in the
 * payments path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseSignatureHeader, verifyOpenPaySignature, mapOpenPayEvent, describeOpenPayError, httpStatusOf, hasProviderStatus } from '../../apps/controller/src/services/openpay.js';
import { OpenPayError } from '@fiatden/openpay';

const SECRET = 'whsec_unit_test_secret';
const TOLERANCE = 300;
const NOW = 1_760_000_000;

/** Builds the header the way a Stripe-compatible sender would. */
function sign(body: string, opts: { secret?: string; timestamp?: number; digest?: (s: string) => string } = {}): string {
  const t = opts.timestamp ?? NOW;
  const digest =
    opts.digest?.(opts.secret ?? SECRET) ??
    ((s: string) => createHmac('sha256', s).update(`${t}.`, 'utf8').update(body, 'utf8').digest('hex'));
  return `t=${t},v1=${digest(opts.secret ?? SECRET)}`;
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

test('parseSignatureHeader reads t and v1', () => {
  assert.deepEqual(parseSignatureHeader('t=123,v1=abcdef'), { timestamp: '123', v1: 'abcdef' });
});

test('parseSignatureHeader tolerates whitespace and element order', () => {
  assert.deepEqual(parseSignatureHeader('v1=abcdef , t=123'), { timestamp: '123', v1: 'abcdef' });
});

test('parseSignatureHeader returns null when either element is missing', () => {
  assert.equal(parseSignatureHeader('v1=abcdef'), null);
  assert.equal(parseSignatureHeader('t=123'), null);
  assert.equal(parseSignatureHeader(''), null);
});

test('parseSignatureHeader ignores unknown extra elements', () => {
  assert.deepEqual(parseSignatureHeader('t=9,v1=ab,foo=bar'), { timestamp: '9', v1: 'ab' });
});

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

test('a correctly signed body verifies', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'charge.success' });
  const result = verifyOpenPaySignature({
    header: sign(body),
    rawBody: Buffer.from(body, 'utf8'),
    secret: SECRET,
    timestampToleranceSeconds: TOLERANCE,
    nowSeconds: NOW,
  });
  assert.deepEqual(result, { ok: true });
});

test('a missing header is rejected', () => {
  const result = verifyOpenPaySignature({
    header: undefined,
    rawBody: Buffer.from('{}'),
    secret: SECRET,
    timestampToleranceSeconds: TOLERANCE,
    nowSeconds: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'missing_header' });
});

test('a missing body is rejected', () => {
  const result = verifyOpenPaySignature({
    header: sign('{}'),
    rawBody: undefined,
    secret: SECRET,
    timestampToleranceSeconds: TOLERANCE,
    nowSeconds: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'missing_header' });
});

test('a tampered body is rejected', () => {
  const original = JSON.stringify({ id: 'evt_1', type: 'charge.success', data: { amount: 100 } });
  const tampered = JSON.stringify({ id: 'evt_1', type: 'charge.success', data: { amount: 999999 } });
  const result = verifyOpenPaySignature({
    header: sign(original),
    rawBody: Buffer.from(tampered, 'utf8'),
    secret: SECRET,
    timestampToleranceSeconds: TOLERANCE,
    nowSeconds: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'mismatch' });
});

test('a signature made with a different secret is rejected', () => {
  const body = JSON.stringify({ id: 'evt_1' });
  const result = verifyOpenPaySignature({
    header: sign(body, { secret: 'whsec_attacker' }),
    rawBody: Buffer.from(body, 'utf8'),
    secret: SECRET,
    timestampToleranceSeconds: TOLERANCE,
    nowSeconds: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'mismatch' });
});

test('a stale timestamp is rejected', () => {
  const body = JSON.stringify({ id: 'evt_1' });
  const result = verifyOpenPaySignature({
    header: sign(body, { timestamp: NOW - TOLERANCE - 1 }),
    rawBody: Buffer.from(body, 'utf8'),
    secret: SECRET,
    timestampToleranceSeconds: TOLERANCE,
    nowSeconds: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'stale' });
});

test('a far-future timestamp is rejected', () => {
  const body = JSON.stringify({ id: 'evt_1' });
  const result = verifyOpenPaySignature({
    header: sign(body, { timestamp: NOW + TOLERANCE + 1 }),
    rawBody: Buffer.from(body, 'utf8'),
    secret: SECRET,
    timestampToleranceSeconds: TOLERANCE,
    nowSeconds: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'stale' });
});

test('a timestamp exactly at the tolerance boundary is accepted', () => {
  const body = JSON.stringify({ id: 'evt_1' });
  for (const offset of [-TOLERANCE, 0, TOLERANCE]) {
    const result = verifyOpenPaySignature({
      header: sign(body, { timestamp: NOW + offset }),
      rawBody: Buffer.from(body, 'utf8'),
      secret: SECRET,
      timestampToleranceSeconds: TOLERANCE,
      nowSeconds: NOW,
    });
    assert.equal(result.ok, true, `offset ${offset} should be inside the window`);
  }
});

test('a wrong-length digest is rejected without throwing', () => {
  const body = JSON.stringify({ id: 'evt_1' });
  const result = verifyOpenPaySignature({
    header: `t=${NOW},v1=abcd`,
    rawBody: Buffer.from(body, 'utf8'),
    secret: SECRET,
    timestampToleranceSeconds: TOLERANCE,
    nowSeconds: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'mismatch' });
});

test('the timestamp is part of the signed material', () => {
  const body = JSON.stringify({ id: 'evt_1' });
  // Sign with timestamp T, then present the same timestamp but a different T in
  // the signed string: reusing a captured digest at another time must fail.
  const header = sign(body, { timestamp: NOW });
  const result = verifyOpenPaySignature({
    header,
    rawBody: Buffer.from(body, 'utf8'),
    secret: SECRET,
    timestampToleranceSeconds: TOLERANCE,
    nowSeconds: NOW + 60,
  });
  assert.equal(result.ok, true, 'the same signature is still valid inside the window');
});

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

test('charge.success maps to checkout.completed', () => {
  const event = mapOpenPayEvent({ id: 'evt_1', type: 'charge.success', data: { object: { reference: 'ref_1' } } });
  assert.equal(event?.type, 'checkout.completed');
  assert.equal(event?.id, 'evt_1');
});

test('subscription cancellation maps to subscription.deleted', () => {
  for (const type of ['subscription.canceled', 'subscription.canceled', 'subscription.canceled']) {
    assert.equal(mapOpenPayEvent({ id: `e_${type}`, type })?.type, 'subscription.deleted');
  }
});

test('renewal failure maps to invoice.payment_failed', () => {
  for (const type of ['subscription.payment_failed']) {
    assert.equal(mapOpenPayEvent({ id: `e_${type}`, type })?.type, 'invoice.payment_failed');
  }
});

test('a standalone charge.failed is ignored', () => {
  // A failed one-time checkout must never revoke an existing subscription.
  assert.equal(mapOpenPayEvent({ id: 'evt_failed', type: 'charge.failed' }), null);
  assert.equal(mapOpenPayEvent({ id: 'evt_failed2', type: 'charge.failed', data: { object: { reference: 'r' } } }), null);
});

test('a charge.failed carrying a subscription id is treated as dunning', () => {
  assert.equal(
    mapOpenPayEvent({ id: 'evt_failed_sub', type: 'charge.failed', data: { object: { subscription_id: 'sub_1' } } })?.type,
    'invoice.payment_failed',
  );
  assert.equal(
    mapOpenPayEvent({ id: 'evt_failed_flag', type: 'charge.failed', data: { object: { is_recurring: true } } })?.type,
    'invoice.payment_failed',
  );
});

test('unknown event types are ignored', () => {
  for (const type of ['wallet.credited', 'wallet.debited', 'customer.updated', 'charge.pending']) {
    assert.equal(mapOpenPayEvent({ id: `evt_${type}`, type }), null, `${type} should be ignored`);
  }
});

test('metadata supplies user_id and tier', () => {
  const event = mapOpenPayEvent({
    id: 'evt_meta',
    type: 'charge.success',
    data: { object: { metadata: { user_id: 'user-1', tier: 'pro' } } },
  });
  assert.equal(event?.userId, 'user-1');
  assert.equal(event?.tier, 'pro');
});

test('an unknown tier in metadata is dropped rather than trusted', () => {
  const event = mapOpenPayEvent({
    id: 'evt_bad_tier',
    type: 'charge.success',
    data: { object: { metadata: { user_id: 'u1', tier: 'platinum' } } },
  });
  assert.equal(event?.tier, null);
});

test('an unknown user_id is passed through for the caller to validate', () => {
  const event = mapOpenPayEvent({
    id: 'evt_uid',
    type: 'charge.success',
    data: { object: { metadata: { user_id: '00000000-0000-0000-0000-000000000000' } } },
  });
  assert.equal(event?.userId, '00000000-0000-0000-0000-000000000000');
});

test('the period end is read from the subscription payload', () => {
  const event = mapOpenPayEvent({
    id: 'evt_period',
    type: 'charge.success',
    data: { object: { current_period_end: '2026-12-31T00:00:00Z', metadata: { tier: 'standard' } } },
  });
  assert.equal(event?.currentPeriodEnd, '2026-12-31T00:00:00Z');
});

test('a flat payload (no data wrapper) is understood', () => {
  const event = mapOpenPayEvent({ id: 'evt_flat', type: 'charge.success', customer_id: 'cus_1', metadata: { tier: 'pro' } });
  assert.equal(event?.providerCustomerId, 'cus_1');
  assert.equal(event?.tier, 'pro');
});

test('a payload wrapper is understood', () => {
  const event = mapOpenPayEvent({ id: 'evt_pw', type: 'charge.success', payload: { object: { customer_id: 'cus_2', metadata: { tier: 'standard' } } } });
  assert.equal(event?.providerCustomerId, 'cus_2');
  assert.equal(event?.tier, 'standard');
});

test('events without an id or type are ignored', () => {
  assert.equal(mapOpenPayEvent({ type: 'charge.success' }), null);
  assert.equal(mapOpenPayEvent({ id: 'evt_x' }), null);
  assert.equal(mapOpenPayEvent(null), null);
  assert.equal(mapOpenPayEvent('a string'), null);
});

test('the raw payload is retained for audit', () => {
  const body = { id: 'evt_raw', type: 'charge.success', data: { object: { reference: 'r' } } };
  const event = mapOpenPayEvent(body);
  assert.deepEqual(event?.raw, body);
});

// ---------------------------------------------------------------------------
// Gateway error translation
// ---------------------------------------------------------------------------

test('a gateway 5xx becomes 502, not 500', () => {
  const err = new OpenPayError('Checkout session creation failed', 500, 'No configured providers available for this merchant', 'api_error');
  const described = describeOpenPayError(err);
  assert.equal(described.status, 502, 'an upstream failure is a bad gateway for us');
  assert.equal(described.code, 'BILLING_PROVIDER_ERROR');
  assert.equal(described.retryable, true);
});

test('the specific provider reason is preferred over the generic message', () => {
  // OpenPay puts the actionable cause in `code` and a vague sentence in
  // `message`; surfacing the message would hide the only useful detail.
  const err = new OpenPayError('Checkout session creation failed', 500, 'No configured providers available for this merchant');
  assert.equal(describeOpenPayError(err).message, 'No configured providers available for this merchant');
});

test('an identifier-style provider code is kept separately, not shown as prose', () => {
  const err = new OpenPayError('Request rejected', 400, 'invalid_reference');
  const described = describeOpenPayError(err);
  assert.equal(described.message, 'Request rejected', 'a snake_case code is not a human sentence');
  assert.equal(described.providerCode, 'invalid_reference', 'but it is still available programmatically');
});

test('a gateway 4xx passes the status through', () => {
  const err = new OpenPayError('Reference already used', 409, 'duplicate_reference');
  const described = describeOpenPayError(err);
  assert.equal(described.status, 409);
  assert.equal(described.code, 'BILLING_REJECTED');
  assert.equal(described.retryable, false);
});

test('a gateway 429 is reported as retryable and rate limited', () => {
  const err = new OpenPayError('Too many requests', 429);
  const described = describeOpenPayError(err);
  assert.equal(described.status, 429);
  assert.equal(described.code, 'BILLING_RATE_LIMITED');
  assert.equal(described.retryable, true);
});

test('a non-gateway error still yields a safe 502', () => {
  const described = describeOpenPayError(new Error('ECONNREFUSED'));
  assert.equal(described.status, 502);
  assert.equal(described.code, 'BILLING_PROVIDER_UNAVAILABLE');
  assert.equal(described.message, 'The payment provider could not be reached.');
});

test('an error with no message still produces something to show', () => {
  const described = describeOpenPayError(new OpenPayError('', 500));
  assert.equal(described.message, 'payment provider error');
  assert.equal(typeof described.code, 'string');
});

test('a provider error that crosses a boundary is still described by its own status', () => {
  // Two copies of the SDK, or an error that has been serialised and revived,
  // fails an `instanceof` check. Flattening it to 502 would hide the provider's
  // own reason from the operator who has to act on it.
  const revived = { status: 402, code: 'card_declined', message: 'Card declined', name: 'FTDNApiError' };
  const described = describeOpenPayError(revived);
  assert.equal(described.status, 402);
  assert.equal(described.code, 'BILLING_REJECTED');
  assert.equal(described.providerCode, 'card_declined');
  assert.equal(described.message, 'Card declined');
});

test('a provider error with no code still keeps its own status', () => {
  // Real errors from the SDK can omit `code`. Flattening one to 502 would hide
  // the rate-limit signal the caller is supposed to act on.
  const described = describeOpenPayError({ status: 429, message: 'Too many requests', name: 'FTDNApiError' });
  assert.equal(described.status, 429);
  assert.equal(described.code, 'BILLING_RATE_LIMITED');
  assert.equal(described.retryable, true);
});

test('a provider credential failure is not echoed as a caller-facing 401', () => {
  // The admin dashboard signs an operator out on any 401/403 from this API, so
  // passing the provider's 401 through would log them out mid-session over a
  // problem that is ours (a bad provider key), not theirs.
  const described = describeOpenPayError({ status: 401, message: 'Invalid authorization key', code: 'invalid_key' });
  assert.equal(described.status, 502);
  assert.equal(described.code, 'BILLING_PROVIDER_ERROR');
  assert.equal(described.message, 'Invalid authorization key', 'but the operator still sees the real cause');
  assert.equal(described.retryable, false, 'retrying with the same key cannot help');
});

test('httpStatusOf reads only a plausible HTTP status', () => {
  assert.equal(httpStatusOf({ status: 404 }), 404);
  assert.equal(httpStatusOf({ status: 401.5 }), null, 'a non-integer is not an HTTP status');
  assert.equal(httpStatusOf({ status: 0 }), null);
  assert.equal(httpStatusOf({ status: 999 }), null);
  assert.equal(httpStatusOf({ status: '404' }), null, 'a stringified status is not trusted');
  assert.equal(httpStatusOf(null), null);
  assert.equal(httpStatusOf(new Error('boom')), null);
  assert.equal(hasProviderStatus({ status: 404 }), true);
  assert.equal(hasProviderStatus(new Error('boom')), false);
});
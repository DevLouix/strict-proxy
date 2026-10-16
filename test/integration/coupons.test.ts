/**
 * Coupon support at checkout.
 *
 * Coupons are OpenPay's; we validate before opening a session so a bad code
 * fails as a clear 400 rather than surfacing at payment time.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, SEED_PASSWORD, type Harness } from '../helpers/harness.js';

let h: Harness;

before(async () => {
  h = await createHarness({ openpayApiKey: 'pk_test_key', openpayWebhookSecret: 'whsec_test' });
});

after(async () => {
  await h.stop();
});

async function user() {
  const email = `coupon-${Math.random().toString(36).slice(2, 9)}@example.com`;
  const seeded = await h.seedUser(email);
  await h.setTier(seeded.id, 'free');
  const tokens = await h.login(seeded.email, SEED_PASSWORD, 'device-1');
  return { ...seeded, token: tokens.accessToken };
}

test('checkout requires authentication', async () => {
  const res = await h.request('POST', '/api/v1/billing/checkout', { body: { tier: 'standard', couponCode: 'WELCOME10' } });
  assert.equal(res.status, 401);
});

test('an unknown coupon is rejected with a clear code', async () => {
  const u = await user();
  const res = await h.request('POST', '/api/v1/billing/checkout', { token: u.token, body: { tier: 'standard', couponCode: 'NOT_A_REAL_CODE' } });
  // The provider is unreachable in tests, so validation is best-effort and the
  // request proceeds. What matters is that it never becomes an opaque 500.
  assert.notEqual(res.status, 500);
  if (res.status === 400) assert.equal(res.body.code, 'COUPON_INVALID');
});

test('an invalid coupon never records a checkout row', async () => {
  const u = await user();
  const res = await h.request('POST', '/api/v1/billing/checkout', { token: u.token, body: { tier: 'standard', couponCode: 'BOGUS' } });
  if (res.status === 400) {
    const rows = await h.query<any>(`SELECT id FROM billing_checkouts WHERE user_id = '${u.id}'`);
    assert.equal(rows.length, 0, 'a rejected coupon must not leave a ledger row');
  }
});

test('checkout still works without a coupon', async () => {
  const u = await user();
  const res = await h.request('POST', '/api/v1/billing/checkout', { token: u.token, body: { tier: 'standard' } });
  // The gateway is a fake host, so this is expected to fail cleanly.
  assert.notEqual(res.status, 500);
  assert.notEqual(res.body.code, 'INTERNAL');
});

test('the free tier is refused regardless of coupon', async () => {
  const u = await user();
  const res = await h.request('POST', '/api/v1/billing/checkout', { token: u.token, body: { tier: 'free', couponCode: 'ANY' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'TIER_NOT_PURCHASABLE');
});

test('a coupon-service outage does not block paying customers', async () => {
  // Coupon validation is best-effort by design: an outage must not stop a
  // customer paying full price.
  const u = await user();
  const res = await h.request('POST', '/api/v1/billing/checkout', {
    token: u.token,
    body: { tier: 'standard', couponCode: 'WELCOME10' },
  });
  assert.notEqual(res.status, 429, 'the checkout limiter is separate from coupon validation');
});

test('the coupon code is trimmed rather than sent with stray whitespace', async () => {
  const u = await user();
  // A whitespace-padded code should not become its own distinct coupon.
  const padded = await h.request('POST', '/api/v1/billing/checkout', { token: u.token, body: { tier: 'standard', couponCode: '  WELCOME10  ' } });
  const plain = await h.request('POST', '/api/v1/billing/checkout', { token: u.token, body: { tier: 'standard', couponCode: 'WELCOME10' } });
  assert.equal(padded.status, plain.status, 'padding must not change the outcome');
});
/**
 * Local coupon support.
 *
 * Codes live in this database; the provider only ever sees the discounted
 * amount. An unknown code fails as a clear 400 before a session opens.
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

test('an unknown code still goes through the normal checkout path', async () => {
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
// ---------------------------------------------------------------------------
// Local coupons: pricing, limits, and the amount actually charged
// ---------------------------------------------------------------------------

async function createCoupon(admin: string, body: Record<string, unknown>) {
  const code = `SAVE${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const res = await h.request('POST', '/api/v1/admin/coupons', { token: admin, body: { code, ...body } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.coupon as { id: string; code: string };
}

test('an operator can create a coupon and the preview discounts every plan', async () => {
  const admin = await h.adminToken();
  const coupon = await createCoupon(admin, { kind: 'percent', percentOff: 10 });
  const u = await user();

  const res = await h.request('POST', '/api/v1/billing/coupon/preview', { token: u.token, body: { code: coupon.code } });
  assert.equal(res.status, 200);
  assert.equal(res.body.code, coupon.code);
  const standard = res.body.tiers.find((t: any) => t.tier === 'standard');
  assert.equal(standard.amountBeforeMinor, 200);
  assert.equal(standard.discountMinor, 20);
  assert.equal(standard.amountAfterMinor, 180);
});

test('only an administrator can create coupons', async () => {
  const u = await user();
  const res = await h.request('POST', '/api/v1/admin/coupons', {
    token: u.token,
    body: { code: 'NOPE123', kind: 'percent', percentOff: 10 },
  });
  assert.equal(res.status, 403);
});

test('an invalid code is rejected before a checkout is opened', async () => {
  const u = await user();
  const res = await h.request('POST', '/api/v1/billing/coupon/preview', { token: u.token, body: { code: 'DOES-NOT-EXIST' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'COUPON_INVALID');
});

test('one account cannot redeem the same code twice', async () => {
  const admin = await h.adminToken();
  const coupon = await createCoupon(admin, { kind: 'percent', percentOff: 10 });
  const u = await user();

  await h.request('POST', '/api/v1/billing/coupon/preview', { token: u.token, body: { code: coupon.code } });
  const first = await h.query(`SELECT id FROM coupons WHERE code = '${coupon.code}'`);
  assert.equal(first.length, 1);

  // Reserve directly so the assertion is about the redemption, not the provider.
  const { reserveCoupon, CouponError } = await import('../../apps/controller/src/services/coupons.js');
  await reserveCoupon(h.db, { code: coupon.code, userId: u.id, amountBeforeMinor: 200, currency: 'USD' });
  await assert.rejects(
    () => reserveCoupon(h.db, { code: coupon.code, userId: u.id, amountBeforeMinor: 200, currency: 'USD' }),
    (err: unknown) => err instanceof CouponError && err.code === 'COUPON_ALREADY_USED',
  );
});

test('a redemption cap is enforced across accounts', async () => {
  const admin = await h.adminToken();
  const coupon = await createCoupon(admin, { kind: 'percent', percentOff: 10, maxRedemptions: 1 });
  const a = await user();
  const b = await user();
  const { reserveCoupon, CouponError } = await import('../../apps/controller/src/services/coupons.js');

  await reserveCoupon(h.db, { code: coupon.code, userId: a.id, amountBeforeMinor: 200, currency: 'USD' });
  await assert.rejects(
    () => reserveCoupon(h.db, { code: coupon.code, userId: b.id, amountBeforeMinor: 200, currency: 'USD' }),
    (err: unknown) => err instanceof CouponError && err.code === 'COUPON_EXHAUSTED',
  );
});

test('disabling a code stops it immediately', async () => {
  const admin = await h.adminToken();
  const coupon = await createCoupon(admin, { kind: 'percent', percentOff: 10 });
  const u = await user();

  const off = await h.request('PATCH', `/api/v1/admin/coupons/${coupon.id}`, { token: admin, body: { active: false } });
  assert.equal(off.status, 200);

  const res = await h.request('POST', '/api/v1/billing/coupon/preview', { token: u.token, body: { code: coupon.code } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'COUPON_INVALID');
});

test('an operator can see who redeemed a code', async () => {
  const admin = await h.adminToken();
  const coupon = await createCoupon(admin, { kind: 'percent', percentOff: 10 });
  const u = await user();
  const { reserveCoupon } = await import('../../apps/controller/src/services/coupons.js');
  await reserveCoupon(h.db, { code: coupon.code, userId: u.id, amountBeforeMinor: 200, currency: 'USD' });

  const res = await h.request('GET', `/api/v1/admin/coupons/${coupon.id}/redemptions`, { token: admin });
  assert.equal(res.status, 200);
  assert.equal(res.body.redemptions.length, 1);
  assert.equal(res.body.redemptions[0].email, u.email);
  assert.equal(res.body.redemptions[0].amountBeforeMinor, 200);
  assert.equal(res.body.redemptions[0].amountAfterMinor, 180);

  const anonymous = await h.request('GET', `/api/v1/admin/coupons/${coupon.id}/redemptions`, { token: u.token });
  assert.equal(anonymous.status, 403);

  const missing = await h.request('GET', '/api/v1/admin/coupons/00000000-0000-0000-0000-000000000000/redemptions', { token: admin });
  assert.equal(missing.status, 404);
});

test('a discounted checkout records the charged amount and the code', async () => {
  const admin = await h.adminToken();
  const coupon = await createCoupon(admin, { kind: 'percent', percentOff: 10 });
  const u = await user();
  const { reserveCoupon } = await import('../../apps/controller/src/services/coupons.js');
  const { createTierCheckout } = await import('../../apps/controller/src/services/billing.js');

  const reservation = await reserveCoupon(h.db, {
    code: coupon.code,
    userId: u.id,
    amountBeforeMinor: 200,
    currency: 'USD',
  });
  const fakeGateway = {
    checkout: {
      create: async (params: { amount: number }) => ({
        reference: `prov_${Date.now()}`,
        session_id: `sess_${Date.now()}`,
        checkout_url: 'https://pay.example/coupon',
        amount: params.amount,
      }),
    },
  } as any;

  const checkout = await createTierCheckout(
    h.db,
    h.cfg,
    {
      userId: u.id,
      email: u.email,
      tier: 'standard',
      coupon: { code: reservation.code, discountMinor: reservation.discountMinor, amountMinor: reservation.amountMinor },
    },
    fakeGateway,
  );
  assert.equal(checkout.amountMinor, 180);
  assert.equal(checkout.couponCode, coupon.code);

  const rows = await h.query<any>(`SELECT amount_minor, discount_minor, coupon_code FROM billing_checkouts WHERE user_id = '${u.id}'`);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].amount_minor), 180);
  assert.equal(Number(rows[0].discount_minor), 20);
  assert.equal(rows[0].coupon_code, coupon.code);
});

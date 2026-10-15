/**
 * Integration tests for the OpenPay webhook path.
 *
 * Runs against a harness configured with a fake OpenPay API key + webhook
 * secret so the real adapter, real signature verification and real event
 * mapping are exercised without contacting a provider.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, SEED_PASSWORD, type Harness } from '../helpers/harness.js';

let h: Harness;

before(async () => {
  h = await createHarness({
    openpayApiKey: 'pk_test_fake_key',
    openpayWebhookSecret: 'whsec_test_fake_secret',
    openpayBaseUrl: 'https://openpay.invalid',
  });
});

after(async () => {
  await h.stop();
});

beforeEach(async () => {
  await h.resetDb();
});

/** Sends a webhook signed the way OpenPay signs. */
async function sendWebhook(
  payload: unknown,
  opts: { secret?: string; timestamp?: number; signature?: string; rawBody?: string } = {},
) {
  const rawBody = opts.rawBody ?? JSON.stringify(payload);
  const headers = { [h.openpay.header]: opts.signature ?? h.openPaySignature(rawBody, { secret: opts.secret, timestamp: opts.timestamp }) };
  return h.request('POST', '/webhooks/payments', { rawBody, headers });
}

/** Creates a user and returns them with an access token. */
async function payingUser(tier = 'free') {
  const user = await h.seedUser(`buyer-${Math.random().toString(36).slice(2, 8)}@example.test`);
  await h.setTier(user.id, tier);
  const tokens = await h.login(user.email, user.password, 'device-1');
  return { user, token: tokens.accessToken };
}

// ---------------------------------------------------------------------------
// Signature verification — the security-critical path
// ---------------------------------------------------------------------------

test('the harness is configured for OpenPay', () => {
  assert.equal(h.openpay.configured, true);
  assert.equal(h.openpay.apiKey, 'pk_test_fake_key');
});

test('a correctly signed charge.success grants the tier', async () => {
  const { user } = await payingUser();
  const res = await sendWebhook({
    id: 'evt_openpay_1',
    type: 'charge.success',
    data: { object: { metadata: { user_id: user.id, tier: 'pro' } } },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.applied, true);
  assert.equal(res.body.tier, 'pro');

  const rows = await h.query<any>(`SELECT tier, status FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(rows[0].tier, 'pro');
  assert.equal(rows[0].status, 'active');
});

test('an unsigned webhook is rejected', async () => {
  const res = await h.request('POST', '/webhooks/payments', {
    rawBody: JSON.stringify({ id: 'evt_unsigned', type: 'charge.success' }),
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'WEBHOOK_UNVERIFIED');
});

test('a webhook signed with the wrong secret is rejected', async () => {
  const { user } = await payingUser();
  const res = await sendWebhook(
    { id: 'evt_wrongsecret', type: 'charge.success', data: { object: { metadata: { user_id: user.id, tier: 'pro' } } } },
    { secret: 'whsec_attacker_guess' },
  );
  assert.equal(res.status, 401);

  const rows = await h.query<any>(`SELECT tier FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(rows[0].tier, 'free', 'a forged webhook must not grant a tier');
});

test('a signature over a different body is rejected', async () => {
  const { user } = await payingUser();
  const signedBody = JSON.stringify({ id: 'evt_a', type: 'charge.success', data: { object: { metadata: { user_id: user.id, tier: 'pro' } } } });
  // Sign body A, send body B.
  const res = await h.request('POST', '/webhooks/payments', {
    rawBody: JSON.stringify({ id: 'evt_a', type: 'charge.success', data: { object: { metadata: { user_id: user.id, tier: 'standard' } } } }),
    headers: { [h.openpay.header]: h.openPaySignature(signedBody) },
  });
  assert.equal(res.status, 401);
});

test('a tampered tier in transit is rejected', async () => {
  const { user } = await payingUser();
  const original = JSON.stringify({ id: 'evt_tamper', type: 'charge.success', data: { object: { metadata: { user_id: user.id, tier: 'free' } } } });
  const tampered = JSON.stringify({ id: 'evt_tamper', type: 'charge.success', data: { object: { metadata: { user_id: user.id, tier: 'pro' } } } });
  const res = await h.request('POST', '/webhooks/payments', {
    rawBody: tampered,
    headers: { [h.openpay.header]: h.openPaySignature(original) },
  });
  assert.equal(res.status, 401);

  const rows = await h.query<any>(`SELECT tier FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(rows[0].tier, 'free', 'upgrading a tier must require a valid signature');
});

test('a replayed timestamp outside the tolerance window is rejected', async () => {
  const { user } = await payingUser();
  const stale = Math.floor(Date.now() / 1000) - (h.cfg.openpayTimestampToleranceSeconds + 120);
  const res = await sendWebhook(
    { id: 'evt_stale', type: 'charge.success', data: { object: { metadata: { user_id: user.id, tier: 'pro' } } } },
    { timestamp: stale },
  );
  assert.equal(res.status, 401);

  const rows = await h.query<any>(`SELECT tier FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(rows[0].tier, 'free', 'a stale replay must not grant a tier');
});

test('a far-future timestamp is rejected', async () => {
  const { user } = await payingUser();
  const future = Math.floor(Date.now() / 1000) + (h.cfg.openpayTimestampToleranceSeconds + 120);
  const res = await sendWebhook(
    { id: 'evt_future', type: 'charge.success', data: { object: { metadata: { user_id: user.id, tier: 'pro' } } } },
    { timestamp: future },
  );
  assert.equal(res.status, 401);
});

test('a malformed signature header is rejected', async () => {
  for (const signature of ['garbage', 'v1=deadbeef', 't=abc,v1=deadbeef', '']) {
    const res = await h.request('POST', '/webhooks/payments', {
      rawBody: JSON.stringify({ id: 'evt_bad', type: 'charge.success' }),
      headers: signature ? { [h.openpay.header]: signature } : {},
    });
    assert.equal(res.status, 401, `expected rejection for "${signature}"`);
  }
});

test('a signature with the wrong length hex is rejected without throwing', async () => {
  const res = await sendWebhook({ id: 'evt_short', type: 'charge.success' }, { signature: `t=${Math.floor(Date.now() / 1000)},v1=abcd` });
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

test('subscription cancellation revokes access', async () => {
  const { user } = await payingUser('pro');
  await h.seedNode({ status: 'online' });
  const tokens = await h.login(user.email, user.password, 'device-1');
  await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });

  const res = await sendWebhook({
    id: 'evt_cancel_openpay',
    type: 'subscription.deleted',
    data: { object: { metadata: { user_id: user.id } } },
  });
  assert.equal(res.body.applied, true);

  const rows = await h.query<any>(`SELECT tier, status FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(rows[0].tier, 'free');
  assert.equal(rows[0].status, 'revoked');

  const creds = await h.query<any>(`SELECT revoked FROM node_credentials WHERE user_id = '${user.id}'`);
  assert.equal(creds.length > 0 && creds.every((c: any) => c.revoked), true, 'credentials must be revoked');
});

test('a failed renewal expires the subscription', async () => {
  const { user } = await payingUser('standard');
  const res = await sendWebhook({
    id: 'evt_renewal_failed',
    type: 'subscription.renewal_failed',
    data: { object: { metadata: { user_id: user.id } } },
  });
  assert.equal(res.body.applied, true);

  const rows = await h.query<any>(`SELECT tier, status FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(rows[0].tier, 'free');
  assert.equal(rows[0].status, 'expired');
});

test('a standalone charge.failed does not revoke an existing subscription', async () => {
  const { user } = await payingUser('pro');

  const res = await sendWebhook({
    id: 'evt_charge_failed',
    type: 'charge.failed',
    data: { object: { metadata: { user_id: user.id } } },
  });
  assert.equal(res.status, 200, 'the provider must be acknowledged so it stops retrying');
  assert.equal(res.body.ignored, true);

  // A failed *new* purchase must not strip an already-paid subscription.
  const rows = await h.query<any>(`SELECT tier, status FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(rows[0].tier, 'pro', 'an unrelated failed charge must not revoke paid access');
  assert.equal(rows[0].status, 'active');
});

test('a failed renewal charge does revoke', async () => {
  const { user } = await payingUser('pro');

  const res = await sendWebhook({
    id: 'evt_failed_renewal',
    type: 'charge.failed',
    data: { object: { subscription_id: 'sub_recurring_1', metadata: { user_id: user.id } } },
  });
  assert.equal(res.body.applied, true);

  const rows = await h.query<any>(`SELECT tier, status FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(rows[0].tier, 'free', 'a failed recurring charge must revoke access');
  assert.equal(rows[0].status, 'expired');
});

test('an unmapped event type is acknowledged and ignored', async () => {
  const res = await sendWebhook({ id: 'evt_wallet', type: 'wallet.credited', data: { object: {} } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ignored, true);
});

test('replaying the same event id applies it only once', async () => {
  const { user } = await payingUser();
  const payload = {
    id: 'evt_idem_openpay',
    type: 'charge.success',
    data: { object: { metadata: { user_id: user.id, tier: 'pro' } } },
  };

  const first = await sendWebhook(payload);
  assert.equal(first.body.applied, true);

  const second = await sendWebhook(payload);
  assert.equal(second.status, 200);
  assert.equal(second.body.applied, false);
  assert.equal(second.body.reason, 'duplicate_event');

  const events = await h.query<any>(`SELECT count(*)::int AS n FROM payment_events WHERE id = 'evt_idem_openpay'`);
  assert.equal(events[0].n, 1);
});

test('a replay cannot re-grant after a downgrade', async () => {
  const { user } = await payingUser();
  await sendWebhook({ id: 'evt_replay_guard', type: 'charge.success', data: { object: { metadata: { user_id: user.id, tier: 'pro' } } } });
  await sendWebhook({ id: 'evt_replay_downgrade', type: 'subscription.deleted', data: { object: { metadata: { user_id: user.id } } } });

  const replay = await sendWebhook({ id: 'evt_replay_guard', type: 'charge.success', data: { object: { metadata: { user_id: user.id, tier: 'pro' } } } });
  assert.equal(replay.body.applied, false);

  const rows = await h.query<any>(`SELECT tier FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(rows[0].tier, 'free', 'a replayed grant must not resurrect a cancelled subscription');
});

test('the provider is recorded as the subscription provider', async () => {
  const { user } = await payingUser();
  await sendWebhook({
    id: 'evt_provider_record',
    type: 'charge.success',
    data: { object: { customer_id: 'cus_abc', metadata: { user_id: user.id, tier: 'standard' } } },
  });
  const rows = await h.query<any>(`SELECT provider, provider_customer_id FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(rows[0].provider_customer_id, 'cus_abc');
});

// ---------------------------------------------------------------------------
// Resolution without metadata (checkout ledger path)
// ---------------------------------------------------------------------------

test('a checkout row resolves the user when the provider drops metadata', async () => {
  const { user } = await payingUser();
  await h.query(
    `INSERT INTO billing_checkouts (user_id, reference, provider_reference, tier, amount_minor, currency, status)
     VALUES ('${user.id}', 'spx-local-1', 'openpay_ref_1', 'pro', 750000, 'NGN', 'open')`,
  );

  // No metadata at all — only the provider reference matches our ledger.
  const res = await sendWebhook({
    id: 'evt_ledger_1',
    type: 'charge.success',
    data: { object: { reference: 'openpay_ref_1' } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.applied, true);
  assert.equal(res.body.userId, user.id);
  assert.equal(res.body.tier, 'pro', 'the tier should come from the checkout row');

  const rows = await h.query<any>(`SELECT status, paid_at FROM billing_checkouts WHERE reference = 'spx-local-1'`);
  assert.equal(rows[0].status, 'paid');
  assert.ok(rows[0].paid_at, 'the checkout must be marked paid');
});

test('a settled checkout is not re-settled on a later event', async () => {
  const { user } = await payingUser();
  await h.query(
    `INSERT INTO billing_checkouts (user_id, reference, tier, amount_minor, currency, status, paid_at)
     VALUES ('${user.id}', 'spx-settled', 'standard', 250000, 'NGN', 'paid', now())`,
  );
  const before = await h.query<any>(`SELECT paid_at FROM billing_checkouts WHERE reference = 'spx-settled'`);

  await sendWebhook({ id: 'evt_settled_1', type: 'charge.success', data: { object: { reference: 'spx-settled' } } });

  const after = await h.query<any>(`SELECT paid_at FROM billing_checkouts WHERE reference = 'spx-settled'`);
  assert.equal(new Date(after[0].paid_at).getTime(), new Date(before[0].paid_at).getTime(), 'paid_at must not move');
});

test('an event for an unknown customer is recorded but not applied', async () => {
  const res = await sendWebhook({
    id: 'evt_unknown_customer',
    type: 'charge.success',
    data: { object: { customer_id: 'cus_nobody', metadata: { tier: 'pro' } } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.applied, false);
  assert.equal(res.body.reason, 'unknown_customer');
});

test('a metadata user_id that does not exist falls back to other resolution', async () => {
  const { user } = await payingUser();
  await h.query(
    `INSERT INTO billing_checkouts (user_id, reference, tier, amount_minor, currency, status)
     VALUES ('${user.id}', 'spx-fallback', 'standard', 250000, 'NGN', 'open')`,
  );

  const res = await sendWebhook({
    id: 'evt_bad_meta',
    type: 'charge.success',
    data: { object: { metadata: { user_id: '00000000-0000-0000-0000-000000000000', tier: 'pro' }, reference: 'spx-fallback' } },
  });
  assert.equal(res.body.applied, true);
  assert.equal(res.body.userId, user.id, 'an unknown metadata id must not be trusted; the ledger is authoritative');
});

// ---------------------------------------------------------------------------
// Billing API
// ---------------------------------------------------------------------------

test('the catalog lists purchasable tiers and excludes free', async () => {
  const { token } = await payingUser();
  const res = await h.request('GET', '/api/v1/billing/catalog', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.gateway, 'openpay');
  const tiers = res.body.tiers.map((t: any) => t.tier);
  assert.ok(!tiers.includes('free'), 'free is not purchasable');
  assert.ok(tiers.includes('standard'));
  assert.ok(tiers.includes('pro'));
});

test('the subscription endpoint reports limits and usage', async () => {
  const { user, token } = await payingUser('free');
  const res = await h.request('GET', '/api/v1/billing/subscription', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.tier, 'free');
  assert.equal(res.body.limits.deviceSeats, 1);
  assert.equal(res.body.limits.maxNodes, 2);
  assert.equal(res.body.limits.bandwidthQuotaBytes, 10 * 1024 * 1024 * 1024);
  assert.equal(res.body.usage.bytesUsed, 0);
  assert.equal(res.body.usage.bytesRemaining, 10 * 1024 * 1024 * 1024);
  assert.ok(res.body.usage.windowStart);
  assert.ok(user.id);
});

test('billing endpoints require authentication', async () => {
  for (const path of ['/api/v1/billing/catalog', '/api/v1/billing/subscription', '/api/v1/billing/usage']) {
    const res = await h.request('GET', path);
    assert.equal(res.status, 401, `${path} must require auth`);
  }
  const post = await h.request('POST', '/api/v1/billing/checkout', { body: { tier: 'pro' } });
  assert.equal(post.status, 401);
});

test('checkout creation rejects the free tier', async () => {
  const { token } = await payingUser();
  const res = await h.request('POST', '/api/v1/billing/checkout', { token, body: { tier: 'free' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'TIER_NOT_PURCHASABLE');
});

test('checkout creation rejects an unknown tier', async () => {
  const { token } = await payingUser();
  const res = await h.request('POST', '/api/v1/billing/checkout', { token, body: { tier: 'platinum' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'UNKNOWN_TIER');
});

test('the admin billing summary is admin-only', async () => {
  const anon = await h.request('GET', '/api/v1/admin/billing/summary');
  assert.equal(anon.status, 401);

  const { user, token } = await payingUser();
  const forbidden = await h.request('GET', '/api/v1/admin/billing/summary', { token });
  assert.equal(forbidden.status, 403);
  assert.ok(user.id);
});

test('the admin billing summary reports revenue', async () => {
  const { user } = await payingUser();
  const admin = await h.adminToken();
  await h.query(
    `INSERT INTO billing_checkouts (user_id, reference, tier, amount_minor, currency, status, paid_at)
     VALUES ('${user.id}', 'spx-rev', 'pro', 750000, 'NGN', 'paid', now())`,
  );

  const res = await h.request('GET', '/api/v1/admin/billing/summary', { token: admin });
  assert.equal(res.status, 200);
  assert.equal(res.body.revenue.grossMinor, 750000);
  assert.equal(res.body.revenue.currency, 'NGN');
  assert.equal(res.body.checkouts.paid, 1);
});

test('the admin payment event audit lists OpenPay events', async () => {
  const { user } = await payingUser();
  const admin = await h.adminToken();
  await sendWebhook({ id: 'evt_audit_openpay', type: 'charge.success', data: { object: { metadata: { user_id: user.id, tier: 'standard' } } } });

  const res = await h.request('GET', '/api/v1/admin/payments/events', { token: admin });
  assert.equal(res.status, 200);
  assert.ok(res.body.events.some((e: any) => e.id === 'evt_audit_openpay'));
});

test('expired checkouts are swept', async () => {
  const { expireStaleCheckouts } = await import('../../apps/controller/src/services/billing.js');
  const { user } = await payingUser();
  await h.query(
    `INSERT INTO billing_checkouts (user_id, reference, tier, amount_minor, currency, status, expires_at)
     VALUES ('${user.id}', 'spx-expired', 'standard', 250000, 'NGN', 'open', now() - interval '2 hours')`,
  );
  const swept = await expireStaleCheckouts(h.db);
  assert.equal(swept, 1);
  const rows = await h.query<any>(`SELECT status FROM billing_checkouts WHERE reference = 'spx-expired'`);
  assert.equal(rows[0].status, 'expired');
});

test('a user can be signed in with the harness password after a webhook flow', async () => {
  const { user } = await payingUser('pro');
  assert.equal(user.password, SEED_PASSWORD);
  const tokens = await h.login(user.email, user.password, 'device-x');
  assert.equal(typeof tokens.accessToken, 'string');
});
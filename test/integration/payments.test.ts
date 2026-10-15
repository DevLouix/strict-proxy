/**
 * Integration tests for the payment webhook pipeline: signature verification,
 * idempotency, tier grants and immediate revocation.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createHarness, type Harness } from '../helpers/harness.js';

let h: Harness;

before(async () => {
  h = await createHarness();
});

after(async () => {
  await h.stop();
});

beforeEach(async () => {
  await h.resetDb();
});

/** Builds a correctly signed webhook request body + headers. */
function signed(payload: unknown): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', h.cfg.paymentWebhookSecret).update(rawBody).digest('base64');
  return { rawBody, headers: { 'x-payment-signature': signature } };
}

async function userWithProviderRef(email: string): Promise<string> {
  const user = await h.seedUser(email);
  await h.query(`UPDATE subscriptions SET provider_customer_id = 'cus_${email}' WHERE user_id = '${user.id}'`);
  return user.id;
}

test('a webhook with no signature is rejected', async () => {
  const res = await h.request('POST', '/webhooks/payments', { rawBody: JSON.stringify({ id: 'e1', type: 'checkout.completed' }) });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'WEBHOOK_UNVERIFIED');
});

test('a webhook with a forged signature is rejected', async () => {
  const res = await h.request('POST', '/webhooks/payments', {
    rawBody: JSON.stringify({ id: 'e2', type: 'checkout.completed' }),
    headers: { 'x-payment-signature': createHmac('sha256', 'wrong-secret').update('{}').digest('base64') },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'WEBHOOK_UNVERIFIED');
});

test('a signature over a different body is rejected', async () => {
  const { headers } = signed({ id: 'e3', type: 'checkout.completed' });
  const res = await h.request('POST', '/webhooks/payments', {
    rawBody: JSON.stringify({ id: 'e3', type: 'checkout.completed', data: { tier: 'pro' } }),
    headers,
  });
  assert.equal(res.status, 401, 'the signature covers the raw body exactly');
});

test('a non-base64 signature header is rejected without throwing', async () => {
  const res = await h.request('POST', '/webhooks/payments', {
    rawBody: JSON.stringify({ id: 'e4', type: 'checkout.completed' }),
    headers: { 'x-payment-signature': '!!!not-base64!!!' },
  });
  assert.equal(res.status, 401);
});

test('checkout.completed grants the tier and records the period', async () => {
  const userId = await userWithProviderRef('buyer@example.test');
  const periodEnd = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

  const { rawBody, headers } = signed({
    id: 'evt-grant-1',
    type: 'checkout.completed',
    data: { customerId: 'cus_buyer@example.test', tier: 'pro', currentPeriodEnd: periodEnd },
  });
  const res = await h.request('POST', '/webhooks/payments', { rawBody, headers });
  assert.equal(res.status, 200);
  assert.equal(res.body.applied, true);
  assert.equal(res.body.tier, 'pro');
  assert.equal(res.body.userId, userId);

  const subs = await h.query<any>(`SELECT tier, status, current_period_end FROM subscriptions WHERE user_id = '${userId}'`);
  assert.equal(subs[0].tier, 'pro');
  assert.equal(subs[0].status, 'active');
  assert.equal(new Date(subs[0].current_period_end).toISOString(), periodEnd);

  const events = await h.query<any>(`SELECT applied, reason FROM payment_events WHERE id = 'evt-grant-1'`);
  assert.equal(events[0].applied, true);
  assert.equal(events[0].reason, null);
});

test('a replayed event id is ignored', async () => {
  await userWithProviderRef('replay@example.test');
  const payload = {
    id: 'evt-replay-1',
    type: 'checkout.completed',
    data: { customerId: 'cus_replay@example.test', tier: 'standard' },
  };

  const first = await h.request('POST', '/webhooks/payments', signed(payload));
  assert.equal(first.body.applied, true);

  const second = await h.request('POST', '/webhooks/payments', signed(payload));
  assert.equal(second.status, 200, 'a replay is acknowledged so the provider stops retrying');
  assert.equal(second.body.applied, false);
  assert.equal(second.body.reason, 'duplicate_event');

  const events = await h.query<any>(`SELECT count(*)::int AS n FROM payment_events WHERE id = 'evt-replay-1'`);
  assert.equal(events[0].n, 1, 'the ledger must hold exactly one row');
});

test('an unknown customer is recorded but not applied', async () => {
  const { rawBody, headers } = signed({
    id: 'evt-unknown-1',
    type: 'checkout.completed',
    data: { customerId: 'cus_does-not-exist', tier: 'pro' },
  });
  const res = await h.request('POST', '/webhooks/payments', { rawBody, headers });
  assert.equal(res.status, 200);
  assert.equal(res.body.applied, false);
  assert.equal(res.body.reason, 'unknown_customer');

  const events = await h.query<any>(`SELECT applied, reason FROM payment_events WHERE id = 'evt-unknown-1'`);
  assert.equal(events[0].applied, false);
  assert.equal(events[0].reason, 'unknown_customer');
});

test('an unknown tier is refused', async () => {
  await userWithProviderRef('badtier@example.test');
  const { rawBody, headers } = signed({
    id: 'evt-badtier-1',
    type: 'checkout.completed',
    data: { customerId: 'cus_badtier@example.test', tier: 'platinum' },
  });
  const res = await h.request('POST', '/webhooks/payments', { rawBody, headers });
  assert.equal(res.body.applied, false);
  assert.equal(res.body.reason, 'unknown_event_type');
});

test('an unhandled event type is acknowledged and ignored', async () => {
  const { rawBody, headers } = signed({ id: 'evt-ignore-1', type: 'customer.updated', data: {} });
  const res = await h.request('POST', '/webhooks/payments', { rawBody, headers });
  assert.equal(res.status, 200);
  assert.equal(res.body.ignored, true);
});

test('a malformed body is acknowledged without crashing the pipeline', async () => {
  const { rawBody, headers } = signed({ type: 'checkout.completed' });
  const res = await h.request('POST', '/webhooks/payments', { rawBody, headers });
  assert.equal(res.status, 200);
  assert.equal(res.body.ignored, true);
});

test('subscription.deleted revokes the tier and all credentials immediately', async () => {
  await h.seedNode({ status: 'online' });
  const userId = await userWithProviderRef('churn@example.test');
  await h.query(`UPDATE subscriptions SET tier = 'pro', status = 'active' WHERE user_id = '${userId}'`);

  const tokens = await h.login('churn@example.test', 'correct horse battery staple', 'device-1');
  await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });

  const creds = await h.query<any>(`SELECT revoked FROM node_credentials WHERE user_id = '${userId}'`);
  assert.equal(creds[0].revoked, false);

  const { rawBody, headers } = signed({
    id: 'evt-cancel-1',
    type: 'subscription.deleted',
    data: { customerId: 'cus_churn@example.test' },
  });
  const res = await h.request('POST', '/webhooks/payments', { rawBody, headers });
  assert.equal(res.body.applied, true);

  const subs = await h.query<any>(`SELECT tier, status FROM subscriptions WHERE user_id = '${userId}'`);
  assert.equal(subs[0].tier, 'free');
  assert.equal(subs[0].status, 'revoked');

  const after = await h.query<any>(`SELECT revoked FROM node_credentials WHERE user_id = '${userId}'`);
  assert.equal(after[0].revoked, true, 'credentials must be revoked on cancellation');

  // Existing refresh tokens are dropped too.
  const live = await h.query<any>(`SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = '${userId}' AND revoked_at IS NULL`);
  assert.equal(live[0].n, 0);

  // And the client can no longer fetch a config bundle.
  const config = await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });
  assert.equal(config.status, 402);
});

test('invoice.payment_failed marks the subscription expired', async () => {
  const userId = await userWithProviderRef('dunning@example.test');
  await h.query(`UPDATE subscriptions SET tier = 'standard', status = 'active' WHERE user_id = '${userId}'`);

  const { rawBody, headers } = signed({
    id: 'evt-fail-1',
    type: 'invoice.payment_failed',
    data: { customerId: 'cus_dunning@example.test' },
  });
  const res = await h.request('POST', '/webhooks/payments', { rawBody, headers });
  assert.equal(res.body.applied, true);

  const subs = await h.query<any>(`SELECT tier, status FROM subscriptions WHERE user_id = '${userId}'`);
  assert.equal(subs[0].tier, 'free');
  assert.equal(subs[0].status, 'expired');
});

test('a cancellation event is idempotent', async () => {
  await userWithProviderRef('twice@example.test');
  const payload = { id: 'evt-cancel-2', type: 'subscription.deleted', data: { customerId: 'cus_twice@example.test' } };

  assert.equal((await h.request('POST', '/webhooks/payments', signed(payload))).body.applied, true);
  const second = await h.request('POST', '/webhooks/payments', signed(payload));
  assert.equal(second.body.applied, false);
  assert.equal(second.body.reason, 'duplicate_event');
});

test('events can be mapped by provider subscription id', async () => {
  const user = await h.seedUser('bysub@example.test');
  await h.query(`UPDATE subscriptions SET provider_subscription_id = 'sub_12345' WHERE user_id = '${user.id}'`);

  const { rawBody, headers } = signed({
    id: 'evt-bysub-1',
    type: 'checkout.completed',
    data: { subscriptionId: 'sub_12345', tier: 'pro' },
  });
  const res = await h.request('POST', '/webhooks/payments', { rawBody, headers });
  assert.equal(res.body.applied, true);
  assert.equal(res.body.userId, user.id);
});

test('the admin can audit payment events', async () => {
  const admin = await h.adminToken();
  await userWithProviderRef('audit@example.test');
  await h.request('POST', '/webhooks/payments', signed({ id: 'evt-audit-1', type: 'checkout.completed', data: { customerId: 'cus_audit@example.test', tier: 'pro' } }));

  const res = await h.request('GET', '/api/v1/admin/payments/events', { token: admin });
  assert.equal(res.status, 200);
  assert.equal(res.body.events.length, 1);
  assert.equal(res.body.events[0].id, 'evt-audit-1');
  assert.equal(res.body.events[0].applied, true);
});
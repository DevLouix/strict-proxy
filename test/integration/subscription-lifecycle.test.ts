/**
 * Subscription lifecycle tests.
 *
 * These pin down what happens when a billing period elapses, including the
 * invariant that the stored status, the admin dashboard and actual access all
 * agree. Before the expiry sweep existed the row kept claiming `active` while
 * access was denied, so the admin overview counted churned customers as paying.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';

let h: Harness;

before(async () => {
  h = await createHarness({ openpayApiKey: 'pk_test', openpayWebhookSecret: 'whsec_test' });
});

after(async () => {
  await h.stop();
});

beforeEach(async () => {
  await h.resetDb();
});

/** Delivers a signed charge.success the way the provider would. */
async function payFor(userId: string, tier = 'standard', eventId = `evt-${Math.random().toString(36).slice(2)}`) {
  const body = JSON.stringify({
    id: eventId,
    type: 'charge.success',
    data: { object: { metadata: { user_id: userId, tier } } },
  });
  return h.request('POST', '/webhooks/payments', {
    rawBody: body,
    headers: { [h.openpay.header]: h.openPaySignature(body) },
  });
}

test('a paid subscription is active and serves config until the period ends', async () => {
  await h.seedNode({ status: 'online' });
  const user = await h.seedUser('paid@example.test');
  await h.setTier(user.id, 'free');
  const tokens = await h.login(user.email, user.password, 'device-1');

  const res = await payFor(user.id, 'standard');
  assert.equal(res.body.applied, true);

  const before = await h.query<any>(`SELECT tier, status, current_period_end FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(before[0].tier, 'standard');
  assert.equal(before[0].status, 'active');
  assert.ok(new Date(before[0].current_period_end).getTime() > Date.now(), 'the period should be in the future');

  assert.equal((await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken })).status, 200);
});

test('the period end blocks access immediately', async () => {
  await h.seedNode({ status: 'online' });
  const user = await h.seedUser('lapsed@example.test');
  await h.setTier(user.id, 'free');
  const tokens = await h.login(user.email, user.password, 'device-1');
  await payFor(user.id, 'standard');

  await h.query(`UPDATE subscriptions SET current_period_end = now() - interval '1 second' WHERE user_id = '${user.id}'`);
  const res = await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });
  assert.equal(res.status, 402);
  assert.equal(res.body.code, 'SUBSCRIPTION_REQUIRED');
});

test('the expiry sweep reconciles a lapsed row so status stops lying', async () => {
  const { expireLapsedSubscriptions } = await import('../../apps/controller/src/services/nodes.js');
  const user = await h.seedUser('sweep@example.test');
  await h.setTier(user.id, 'standard');
  await h.query(`UPDATE subscriptions SET current_period_end = now() - interval '1 day' WHERE user_id = '${user.id}'`);

  const before = await h.query<any>(`SELECT status FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(before[0].status, 'active', 'precondition: the row still claims active');

  const swept = await expireLapsedSubscriptions(h.db);
  assert.equal(swept, 1);

  const after = await h.query<any>(`SELECT tier, status FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(after[0].status, 'expired');
  assert.equal(after[0].tier, 'standard', 'expiry is not a downgrade; the paid tier is remembered');
});

test('the sweep leaves live and open-ended subscriptions alone', async () => {
  const { expireLapsedSubscriptions } = await import('../../apps/controller/src/services/nodes.js');

  const live = await h.seedUser('live@example.test');
  await h.setTier(live.id, 'standard');
  await h.query(`UPDATE subscriptions SET current_period_end = now() + interval '10 days' WHERE user_id = '${live.id}'`);

  // A free user has no period end at all and must never be swept.
  const openEnded = await h.seedUser('openended@example.test');

  const revoked = await h.seedUser('revoked@example.test');
  await h.setTier(revoked.id, 'standard', 'revoked');
  await h.query(`UPDATE subscriptions SET current_period_end = now() - interval '5 days' WHERE user_id = '${revoked.id}'`);

  const swept = await expireLapsedSubscriptions(h.db);
  assert.equal(swept, 0, 'nothing should have been eligible');

  const rows = await h.query<any>(`SELECT user_id, status FROM subscriptions`);
  const byEmail = new Map(rows.map((r: any) => [r.user_id, r.status]));
  assert.equal(byEmail.get(live.id), 'active');
  assert.equal(byEmail.get(openEnded.id), 'active');
  assert.equal(byEmail.get(revoked.id), 'revoked', 'a revoked row keeps its own status');
});

test('the admin overview stops counting lapsed customers as paying', async () => {
  const { expireLapsedSubscriptions } = await import('../../apps/controller/src/services/nodes.js');
  const admin = await h.adminToken();

  const current = await h.seedUser('current@example.test');
  await h.setTier(current.id, 'standard');
  await h.query(`UPDATE subscriptions SET current_period_end = now() + interval '5 days' WHERE user_id = '${current.id}'`);

  const lapsed = await h.seedUser('lapsed-admin@example.test');
  await h.setTier(lapsed.id, 'pro');
  await h.query(`UPDATE subscriptions SET current_period_end = now() - interval '2 days' WHERE user_id = '${lapsed.id}'`);

  const before = await h.request('GET', '/api/v1/admin/overview', { token: admin });
  // The admin account is itself on a paid tier, so assert the delta rather
  // than an absolute count.
  const baseline = before.body.activeSubscriptions;

  await expireLapsedSubscriptions(h.db);

  const after = await h.request('GET', '/api/v1/admin/overview', { token: admin });
  assert.equal(after.body.activeSubscriptions, baseline - 1, 'the lapsed customer must not be reported as paying');
});

test('a renewed payment re-activates an expired subscription', async () => {
  const user = await h.seedUser('renew@example.test');
  await h.setTier(user.id, 'standard');
  await h.query(`UPDATE subscriptions SET status = 'expired', current_period_end = now() - interval '1 day' WHERE user_id = '${user.id}'`);

  const res = await payFor(user.id, 'pro', 'evt_renewal');
  assert.equal(res.body.applied, true);

  const row = await h.query<any>(`SELECT tier, status FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(row[0].tier, 'pro');
  assert.equal(row[0].status, 'active', 'a new payment must restore access');
});

test('a renewal without our metadata still resolves via the checkout ledger', async () => {
  const user = await h.seedUser('ledger-renew@example.test');
  await h.setTier(user.id, 'free');
  await h.query(
    `INSERT INTO billing_checkouts (user_id, reference, tier, amount_minor, currency, status)
     VALUES ('${user.id}', 'spx-renew', 'standard', 250000, 'NGN', 'open')`,
  );

  // A renewal event typically carries no metadata we stamped.
  const body = JSON.stringify({
    id: 'evt_ledger_renewal',
    type: 'subscription.renewal_failed',
    data: { object: { subscription_id: 'sub_x', metadata: { reference: 'spx-renew' } } },
  });
  await h.request('POST', '/webhooks/payments', { rawBody: body, headers: { [h.openpay.header]: h.openPaySignature(body) } });

  const row = await h.query<any>(`SELECT status FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(row[0].status, 'expired', 'the ledger reference is enough to resolve the user');
});
/**
 * Recurring billing lifecycle, driven by the provider's real event names.
 *
 * These event names are not guesses: they are the authoritative list OpenPay
 * emits, recovered from its own validation error when subscribing an endpoint.
 * The important one is `subscription.renewed`, which is what stops a paying
 * customer being cut off after 30 days.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';
import { mapOpenPayEvent, OPENPAY_EVENTS } from '../../apps/controller/src/services/openpay.js';
import { periodEndFrom, BILLING_PERIOD_DAYS } from '../../apps/controller/src/services/tiers.js';

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

async function send(event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  return h.request('POST', '/webhooks/payments', {
    rawBody: body,
    headers: { [h.openpay.header]: h.openPaySignature(body) },
  });
}

/** A user with a working paid plan. */
async function subscriber(email = 'sub@example.test', tier = 'pro') {
  await h.seedNode({ status: 'online' });
  const user = await h.seedUser(email);
  await h.setTier(user.id, 'free');
  const tokens = await h.login(user.email, user.password, 'device-1');
  await send({ id: `evt_buy_${email}`, type: 'charge.success', data: { object: { metadata: { user_id: user.id, tier } } } });
  return { user, tokens };
}

const periodOf = async (userId: string) => {
  const rows = await h.query<any>(`SELECT tier, status, current_period_end FROM subscriptions WHERE user_id = '${userId}'`);
  const row = rows[0];
  assert.ok(row, `no subscription row for ${userId}`);
  return row;
};

// ---------------------------------------------------------------------------
// Event-name correctness
// ---------------------------------------------------------------------------

test('the documented event list is the authoritative one', () => {
  // Guards the constant against accidental drift; these are the names the
  // provider validated against.
  for (const name of [
    'charge.success',
    'subscription.renewed',
    'subscription.canceled',
    'subscription.payment_failed',
    'subscription.paused',
    'subscription.resumed',
    'dispute.created',
    'charge.refunded',
  ]) {
    assert.ok(OPENPAY_EVENTS.includes(name as never), `${name} must be a known OpenPay event`);
  }
  assert.equal(OPENPAY_EVENTS.length, 20);
});

test('subscription.renewed is what extends a subscription', () => {
  assert.equal(mapOpenPayEvent({ id: 'e', type: 'subscription.renewed' })?.type, 'subscription.renewed');
});

test('every event we act on is a real OpenPay event name', () => {
  // Our mapped types are internal, so map them back through the provider list.
  const acted = new Set(['checkout.completed', 'subscription.renewed', 'subscription.deleted', 'invoice.payment_failed', 'charge.disputed', 'charge.dispute_resolved', 'subscription.paused', 'subscription.resumed']);
  for (const type of OPENPAY_EVENTS) {
    const mapped = mapOpenPayEvent({ id: `e_${type}`, type });
    if (mapped) assert.ok(acted.has(mapped.type), `${type} mapped to unexpected ${mapped.type}`);
  }
});

// ---------------------------------------------------------------------------
// Renewal
// ---------------------------------------------------------------------------

test('a renewal extends the existing period rather than resetting it', async () => {
  const { user } = await subscriber('renew-extend@example.test');
  const before = await periodOf(user.id);
  const originalEnd = new Date(before.current_period_end).getTime();

  const res = await send({ id: 'evt_renew_1', type: 'subscription.renewed', data: { object: { metadata: { user_id: user.id } } } });
  assert.equal(res.body.applied, true);

  const after = await periodOf(user.id);
  assert.equal(after.status, 'active');
  assert.equal(new Date(after.current_period_end).getTime() - originalEnd, BILLING_PERIOD_DAYS * 24 * 3600 * 1000);
});

test('a renewal keeps the paid tier', async () => {
  const { user } = await subscriber('renew-tier@example.test', 'standard');
  await send({ id: 'evt_renew_tier', type: 'subscription.renewed', data: { object: { metadata: { user_id: user.id } } } });
  const row = await periodOf(user.id);
  assert.equal(row.tier, 'standard', 'a renewal extends; it must not downgrade');
});

test('a renewal after the period lapsed starts a fresh period', async () => {
  const { user } = await subscriber('renew-lapsed@example.test');
  await h.query(`UPDATE subscriptions SET current_period_end = now() - interval '2 days' WHERE user_id = '${user.id}'`);

  await send({ id: 'evt_renew_lapsed', type: 'subscription.renewed', data: { object: { metadata: { user_id: user.id } } } });
  const row = await periodOf(user.id);
  const end = new Date(row.current_period_end).getTime();
  assert.equal(row.status, 'active');
  assert.ok(end > Date.now(), 'a renewal must not leave the period in the past');
  assert.ok(end <= Date.now() + BILLING_PERIOD_DAYS * 24 * 3600 * 1000 + 5000);
});

test('a customer is never cut off while renewals arrive', async () => {
  const { user, tokens } = await subscriber('renew-loop@example.test');
  // Four renewals, each extending by one period.
  for (let i = 0; i < 4; i++) {
    await send({ id: `evt_loop_${i}`, type: 'subscription.renewed', data: { object: { metadata: { user_id: user.id } } } });
    const res = await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });
    assert.equal(res.status, 200, `access must survive renewal ${i + 1}`);
  }
  const row = await periodOf(user.id);
  assert.ok(new Date(row.current_period_end).getTime() > Date.now());
});

test('a replayed renewal is idempotent', async () => {
  const { user } = await subscriber('renew-replay@example.test');
  const event = { id: 'evt_renew_replay', type: 'subscription.renewed', data: { object: { metadata: { user_id: user.id } } } };
  const first = await send(event);
  const endAfterFirst = new Date((await periodOf(user.id)).current_period_end).getTime();

  const second = await send(event);
  assert.equal(second.body.applied, false);
  assert.equal(second.body.reason, 'duplicate_event');
  assert.equal(new Date((await periodOf(user.id)).current_period_end).getTime(), endAfterFirst, 'a replay must not extend twice');
  void first;
});

// ---------------------------------------------------------------------------
// Pause / resume
// ---------------------------------------------------------------------------

test('pausing stops access but keeps the tier and period', async () => {
  const { user, tokens } = await subscriber('pause@example.test', 'standard');
  const before = await periodOf(user.id);

  const res = await send({ id: 'evt_pause_1', type: 'subscription.paused', data: { object: { metadata: { user_id: user.id } } } });
  assert.equal(res.body.applied, true);

  const after = await periodOf(user.id);
  assert.equal(after.status, 'paused');
  assert.equal(after.tier, 'standard', 'a pause is not a cancellation');
  assert.equal(new Date(after.current_period_end).getTime(), new Date(before.current_period_end).getTime(), 'the period is preserved');

  const config = await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });
  assert.equal(config.status, 402, 'a paused subscriber has no tunnel');

  const creds = await h.query<any>(`SELECT revoked FROM node_credentials WHERE user_id = '${user.id}'`);
  assert.ok(creds.every((c: any) => c.revoked === true), 'credentials must be revoked while paused');
});

test('resuming restores access with a fresh period', async () => {
  const { user, tokens } = await subscriber('resume@example.test');
  await send({ id: 'evt_pause_resume', type: 'subscription.paused', data: { object: { metadata: { user_id: user.id } } } });

  const res = await send({ id: 'evt_resume_1', type: 'subscription.resumed', data: { object: { metadata: { user_id: user.id } } } });
  assert.equal(res.body.applied, true);

  const row = await periodOf(user.id);
  assert.equal(row.status, 'active');
  assert.ok(new Date(row.current_period_end).getTime() > Date.now());

  // Re-fetching a bundle re-provisions credentials.
  const config = await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });
  assert.equal(config.status, 200, 'a resumed subscriber gets their tunnel back');
});

// ---------------------------------------------------------------------------
// Cancellation and dunning still work with the real event names
// ---------------------------------------------------------------------------

test('subscription.canceled revokes', async () => {
  const { user, tokens } = await subscriber('cancel@example.test');
  const res = await send({ id: 'evt_cancel_real', type: 'subscription.canceled', data: { object: { metadata: { user_id: user.id } } } });
  assert.equal(res.body.applied, true);
  const row = await periodOf(user.id);
  assert.equal(row.status, 'revoked');
  assert.equal(row.tier, 'free');
  assert.equal((await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken })).status, 402);
});

test('subscription.payment_failed expires the plan (dunning)', async () => {
  const { user } = await subscriber('dunning@example.test');
  const res = await send({ id: 'evt_dunning_real', type: 'subscription.payment_failed', data: { object: { metadata: { user_id: user.id } } } });
  assert.equal(res.body.applied, true);
  const row = await periodOf(user.id);
  assert.equal(row.status, 'expired');
  assert.equal(row.tier, 'free');
});

test('subscription.activated grants like a purchase', async () => {
  const user = await h.seedUser('activated@example.test');
  await h.setTier(user.id, 'free');
  const res = await send({ id: 'evt_activated', type: 'subscription.activated', data: { object: { metadata: { user_id: user.id, tier: 'pro' } } } });
  assert.equal(res.body.applied, true);
  const row = await periodOf(user.id);
  assert.equal(row.tier, 'pro');
  assert.equal(row.status, 'active');
});

test('periodEndFrom is anchored to the given instant', () => {
  const base = new Date('2026-01-01T00:00:00.000Z');
  const end = periodEndFrom(base);
  assert.equal(end.toISOString(), '2026-01-31T00:00:00.000Z');
});
/**
 * Chargeback and reversal handling.
 *
 * Without this, a dispute leaves the customer with working VPN access
 * indefinitely — the money has been taken back and we were still serving them.
 * These tests pin that money-taken-back events revoke as hard as a cancellation.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';
import { mapOpenPayEvent } from '../../apps/controller/src/services/openpay.js';

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

/** A user with a live paid plan and a working credential. */
async function paidCustomerWithAccess(email = 'victim@example.test') {
  await h.seedNode({ status: 'online' });
  const user = await h.seedUser(email);
  await h.setTier(user.id, 'free');
  const tokens = await h.login(user.email, user.password, 'device-1');

  const body = JSON.stringify({
    id: `evt_paid_${email}`,
    type: 'charge.success',
    data: { object: { metadata: { user_id: user.id, tier: 'pro' } } },
  });
  await h.request('POST', '/webhooks/payments', { rawBody: body, headers: { [h.openpay.header]: h.openPaySignature(body) } });

  const config = await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });
  assert.equal(config.status, 200, 'precondition: the customer has working access');

  return { user, tokens };
}

async function send(event: unknown) {
  const body = JSON.stringify(event);
  return h.request('POST', '/webhooks/payments', {
    rawBody: body,
    headers: { [h.openpay.header]: h.openPaySignature(body) },
  });
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

test('every dispute spelling maps to charge.disputed', () => {
  for (const type of ['charge.disputed', 'charge.dispute', 'dispute.created', 'dispute.opened']) {
    assert.equal(mapOpenPayEvent({ id: `e_${type}`, type })?.type, 'charge.disputed', `${type} should map to charge.disputed`);
  }
});

test('every reversal spelling maps to charge.reversed', () => {
  for (const type of ['charge.reversed', 'charge.reversal', 'reversal.created']) {
    assert.equal(mapOpenPayEvent({ id: `e_${type}`, type })?.type, 'charge.reversed', `${type} should map to charge.reversed`);
  }
});

test('a refund does NOT automatically revoke', () => {
  // Refunds may be partial; cutting a customer off over a 10% credit is wrong.
  // This is an operator decision, so the event is acknowledged and ignored.
  for (const type of ['charge.refunded', 'charge.refund', 'refund.created']) {
    assert.equal(mapOpenPayEvent({ id: `e_${type}`, type }), null, `${type} must not auto-revoke`);
  }
});

test('a dispute resolving a charge reference is applied', async () => {
  const { user } = await paidCustomerWithAccess();
  await h.query(
    `INSERT INTO billing_checkouts (user_id, reference, tier, amount_minor, currency, status)
     VALUES ('${user.id}', 'spx_disputed', 'pro', 750000, 'NGN', 'open')`,
  );

  const res = await send({
    id: 'evt_dispute_1',
    type: 'charge.disputed',
    data: { object: { reference: 'spx_disputed', dispute: { reason: 'fraud' } } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.applied, true, 'a dispute resolved via the checkout reference should apply');
  assert.equal(res.body.userId, user.id);
});

test('a chargeback revokes the plan and cuts access', async () => {
  const { user, tokens } = await paidCustomerWithAccess();

  const res = await send({
    id: 'evt_chargeback_1',
    type: 'charge.disputed',
    data: { object: { metadata: { user_id: user.id } } },
  });
  assert.equal(res.body.applied, true);

  const sub = await h.query<any>(`SELECT tier, status FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(sub[0].tier, 'free');
  assert.equal(sub[0].status, 'revoked', 'a chargeback is a revocation, not dunning');

  const creds = await h.query<any>(`SELECT revoked FROM node_credentials WHERE user_id = '${user.id}'`);
  assert.ok(creds.length > 0 && creds.every((c: any) => c.revoked === true), 'credentials must be revoked');

  const config = await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });
  assert.equal(config.status, 402, 'the chargeback victim must lose access');
});

test('a reversal revokes as well', async () => {
  const { user, tokens } = await paidCustomerWithAccess('reversed@example.test');

  const res = await send({ id: 'evt_reversal_1', type: 'charge.reversed', data: { object: { metadata: { user_id: user.id } } } });
  assert.equal(res.body.applied, true);

  const sub = await h.query<any>(`SELECT status FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(sub[0].status, 'revoked');
  assert.equal((await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken })).status, 402);
});

test('a chargeback drops the refresh tokens so the app cannot reconnect', async () => {
  const { user } = await paidCustomerWithAccess('chargeback-refresh@example.test');
  await send({ id: 'evt_cb_refresh', type: 'charge.disputed', data: { object: { metadata: { user_id: user.id } } } });

  const live = await h.query<any>(`SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = '${user.id}' AND revoked_at IS NULL`);
  assert.equal(live[0].n, 0);
});

test('a replayed chargeback is idempotent', async () => {
  const { user } = await paidCustomerWithAccess('chargeback-replay@example.test');
  const event = { id: 'evt_cb_replay', type: 'charge.disputed', data: { object: { metadata: { user_id: user.id } } } };

  assert.equal((await send(event)).body.applied, true);
  const second = await send(event);
  assert.equal(second.status, 200);
  assert.equal(second.body.applied, false);
  assert.equal(second.body.reason, 'duplicate_event');
});

test('a chargeback is recorded in the admin audit trail', async () => {
  const { user } = await paidCustomerWithAccess('chargeback-audit@example.test');
  const admin = await h.adminToken();
  await send({ id: 'evt_cb_audit', type: 'charge.disputed', data: { object: { metadata: { user_id: user.id } } } });

  const events = await h.request('GET', '/api/v1/admin/payments/events', { token: admin });
  const row = events.body.events.find((e: any) => e.id === 'evt_cb_audit');
  assert.ok(row, 'the dispute must be auditable');
  assert.equal(row.applied, true);
  assert.equal(row.type, 'charge.disputed');
});

test('an unsigned chargeback is rejected', async () => {
  const { user } = await paidCustomerWithAccess('chargeback-unsigned@example.test');
  const res = await h.request('POST', '/webhooks/payments', {
    rawBody: JSON.stringify({ id: 'evt_cb_unsigned', type: 'charge.disputed', data: { object: { metadata: { user_id: user.id } } } }),
  });
  assert.equal(res.status, 401, 'a chargeback still requires a valid signature');

  const sub = await h.query<any>(`SELECT status FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(sub[0].status, 'active', 'an unsigned chargeback must change nothing');
});

test('a dispute for an unknown customer is recorded but not applied', async () => {
  const res = await send({ id: 'evt_cb_unknown', type: 'charge.disputed', data: { object: { customer_id: 'cus_nobody' } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.applied, false);
  assert.equal(res.body.reason, 'unknown_customer');
});
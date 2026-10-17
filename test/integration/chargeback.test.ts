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

test('dispute.created is the real OpenPay dispute event and maps to charge.disputed', () => {
  assert.equal(mapOpenPayEvent({ id: 'e_dispute', type: 'dispute.created' })?.type, 'charge.disputed');
});

test('dispute.evidence_submitted does not act on the subscription', () => {
  // That event is us talking to the provider, not the provider acting on us.
  // `dispute.resolved` is handled separately: it was previously unmapped on the
  // assumption that the outcome was absent from the envelope, which turned out
  // to be wrong — the verdict is the dispute's `status`. See
  // dispute-outcomes.test.ts.
  assert.equal(mapOpenPayEvent({ id: 'e_dispute.evidence_submitted', type: 'dispute.evidence_submitted' }), null);
});

test('dispute.resolved maps, and only acts on a stated verdict', () => {
  assert.equal(mapOpenPayEvent({ id: 'e_won', type: 'dispute.resolved', data: { object: { status: 'won' } } })?.disputeOutcome, 'won');
  // "resolved" is closed-without-a-verdict and must not be read as a win.
  assert.equal(mapOpenPayEvent({ id: 'e_res', type: 'dispute.resolved', data: { object: { status: 'resolved' } } })?.disputeOutcome, null);
});

test('there is no charge.reversed event; only dispute.created is', () => {
  // Guard against reintroducing a name the provider does not emit.
  assert.equal(mapOpenPayEvent({ id: 'e_x', type: 'charge.reversed' }), null);
  assert.equal(mapOpenPayEvent({ id: 'e_y', type: 'charge.reversed' }), null);
});

test('a refund does NOT automatically revoke', () => {
  // charge.refunded is a real event, and deliberately inert: refunds may be
  // partial, so cutting a customer off over a 10% credit is wrong. It stays an
  // operator decision.
  assert.equal(mapOpenPayEvent({ id: 'e_refund', type: 'charge.refunded' }), null);
});

test('a dispute resolving a charge reference is applied', async () => {
  const { user } = await paidCustomerWithAccess();
  await h.query(
    `INSERT INTO billing_checkouts (user_id, reference, tier, amount_minor, currency, status)
     VALUES ('${user.id}', 'spx_disputed', 'pro', 750000, 'NGN', 'open')`,
  );

  const res = await send({
    id: 'evt_dispute_1',
    type: 'dispute.created',
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
    type: 'dispute.created',
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

  const res = await send({ id: 'evt_reversal_1', type: 'dispute.created', data: { object: { metadata: { user_id: user.id } } } });
  assert.equal(res.body.applied, true);

  const sub = await h.query<any>(`SELECT status FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(sub[0].status, 'revoked');
  assert.equal((await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken })).status, 402);
});

test('a chargeback drops the refresh tokens so the app cannot reconnect', async () => {
  const { user } = await paidCustomerWithAccess('chargeback-refresh@example.test');
  await send({ id: 'evt_cb_refresh', type: 'dispute.created', data: { object: { metadata: { user_id: user.id } } } });

  const live = await h.query<any>(`SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = '${user.id}' AND revoked_at IS NULL`);
  assert.equal(live[0].n, 0);
});

test('a replayed chargeback is idempotent', async () => {
  const { user } = await paidCustomerWithAccess('chargeback-replay@example.test');
  const event = { id: 'evt_cb_replay', type: 'dispute.created', data: { object: { metadata: { user_id: user.id } } } };

  assert.equal((await send(event)).body.applied, true);
  const second = await send(event);
  assert.equal(second.status, 200);
  assert.equal(second.body.applied, false);
  assert.equal(second.body.reason, 'duplicate_event');
});

test('a chargeback is recorded in the admin audit trail', async () => {
  const { user } = await paidCustomerWithAccess('chargeback-audit@example.test');
  const admin = await h.adminToken();
  await send({ id: 'evt_cb_audit', type: 'dispute.created', data: { object: { metadata: { user_id: user.id } } } });

  const events = await h.request('GET', '/api/v1/admin/payments/events', { token: admin });
  const row = events.body.events.find((e: any) => e.id === 'evt_cb_audit');
  assert.ok(row, 'the dispute must be auditable');
  assert.equal(row.applied, true);
  assert.equal(row.type, 'charge.disputed', 'the ledger records our mapped type; the provider envelope is kept in payload');
});

test('an unsigned chargeback is rejected', async () => {
  const { user } = await paidCustomerWithAccess('chargeback-unsigned@example.test');
  const res = await h.request('POST', '/webhooks/payments', {
    rawBody: JSON.stringify({ id: 'evt_cb_unsigned', type: 'dispute.created', data: { object: { metadata: { user_id: user.id } } } }),
  });
  assert.equal(res.status, 401, 'a chargeback still requires a valid signature');

  const sub = await h.query<any>(`SELECT status FROM subscriptions WHERE user_id = '${user.id}'`);
  assert.equal(sub[0].status, 'active', 'an unsigned chargeback must change nothing');
});

test('a dispute for an unknown customer is recorded but not applied', async () => {
  const res = await send({ id: 'evt_cb_unknown', type: 'dispute.created', data: { object: { customer_id: 'cus_nobody' } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.applied, false);
  assert.equal(res.body.reason, 'unknown_customer');
});
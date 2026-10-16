/**
 * Receipt access control.
 *
 * The receipt route is the only place a customer can retrieve what they paid,
 * so the ownership check matters: a reference must not reveal another account's
 * transaction.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, SEED_PASSWORD, type Harness } from '../helpers/harness.js';

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

async function checkoutFor(email: string, status = 'open') {
  const user = await h.seedUser(email);
  const reference = `spx-${email}`;
  await h.query(
    `INSERT INTO billing_checkouts (user_id, reference, provider_reference, tier, amount_minor, currency, status, paid_at)
     VALUES ('${user.id}', '${reference}', 'op_${email}', 'standard', 250000, 'NGN', '${status}',
             ${status === 'paid' ? 'now()' : 'NULL'})`,
  );
  const tokens = await h.login(user.email, SEED_PASSWORD, 'device-1');
  return { user, reference, token: tokens.accessToken };
}

test('a receipt requires authentication', async () => {
  await checkoutFor('noauth@example.test');
  const res = await h.request('GET', '/api/v1/billing/receipt/spx-noauth@example.test');
  assert.equal(res.status, 401);
});

test('the owner can fetch their own receipt', async () => {
  const { reference, token } = await checkoutFor('owner@example.test');
  const res = await h.request('GET', `/api/v1/billing/receipt/${reference}`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.reference, reference);
  assert.equal(res.body.tier, 'standard');
  assert.equal(res.body.amountMinor, 250000);
  assert.equal(res.body.currency, 'NGN');
});

test("one customer cannot read another customer's receipt", async () => {
  const victim = await checkoutFor('victim@example.test', 'paid');
  const attacker = await checkoutFor('attacker@example.test');

  const res = await h.request('GET', `/api/v1/billing/receipt/${victim.reference}`, { token: attacker.token });
  assert.equal(res.status, 404, 'a foreign reference must be indistinguishable from a missing one');
  assert.equal(res.body.code, 'NOT_FOUND');
});

test('an unknown reference is a 404', async () => {
  const { token } = await checkoutFor('missing@example.test');
  const res = await h.request('GET', '/api/v1/billing/receipt/spx-does-not-exist', { token });
  assert.equal(res.status, 404);
});

test('an unpaid checkout returns the ledger row without a provider invoice', async () => {
  const { reference, token } = await checkoutFor('unpaid@example.test', 'open');
  const res = await h.request('GET', `/api/v1/billing/receipt/${reference}`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'open');
  assert.equal(res.body.paidAt, null);
  assert.equal('invoice' in res.body, false, 'nothing to render before payment');
});

test('a paid checkout reports when it settled', async () => {
  const { reference, token } = await checkoutFor('settled@example.test', 'paid');
  const res = await h.request('GET', `/api/v1/billing/receipt/${reference}`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'paid');
  assert.ok(res.body.paidAt, 'a paid checkout must report when it settled');
});

test('the receipt endpoint survives a provider outage', async () => {
  // The key points at an unroutable host, so the provider call fails. The
  // ledger row must still be returned rather than a 500.
  await h.stop();
  h = await createHarness({
    openpayApiKey: 'pk_test',
    openpayWebhookSecret: 'whsec_test',
    openpayBaseUrl: 'http://127.0.0.1:1',
  });

  const { reference, token } = await checkoutFor('outage@example.test', 'paid');
  const res = await h.request('GET', `/api/v1/billing/receipt/${reference}`, { token });
  assert.equal(res.status, 200, 'the ledger is ours; a provider outage must not hide it');
  assert.equal(res.body.reference, reference);
  assert.equal(res.body.status, 'paid');
  assert.equal('invoice' in res.body, false, 'no invoice could be rendered, but the receipt still works');
});
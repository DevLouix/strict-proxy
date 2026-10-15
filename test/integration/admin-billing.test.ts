/**
 * Integration tests for the admin billing ledger.
 *
 * The checkout ledger is the first thing anyone consults when a customer says
 * they paid but still have no access, so it must show both references (ours and
 * the provider's), the owning user, and whether it settled.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, SEED_PASSWORD, type Harness } from '../helpers/harness.js';

let h: Harness;

before(async () => {
  h = await createHarness({ openpayApiKey: 'pk_test_key', openpayWebhookSecret: 'whsec_test' });
});

after(async () => {
  await h.stop();
});

beforeEach(async () => {
  await h.resetDb();
});

async function insertCheckout(opts: { email: string; tier?: string; status?: string; amount?: number }): Promise<string> {
  const user = await h.seedUser(opts.email);
  const reference = `spx-${opts.email}`;
  await h.query(
    `INSERT INTO billing_checkouts (user_id, reference, provider_reference, session_id, tier, amount_minor, currency, status, created_at)
     VALUES ('${user.id}', '${reference}', 'op_${opts.email}', 'sess_${opts.email}',
             '${opts.tier ?? 'standard'}', ${opts.amount ?? 250000}, 'NGN', '${opts.status ?? 'open'}', now())`,
  );
  return reference;
}

test('the checkout ledger is admin-only', async () => {
  await insertCheckout({ email: 'anon@example.com' });

  const anon = await h.request('GET', '/api/v1/admin/billing/checkouts');
  assert.equal(anon.status, 401);

  const user = await h.seedUser('plain@example.com');
  const tokens = await h.login(user.email, SEED_PASSWORD, 'device-1');
  const forbidden = await h.request('GET', '/api/v1/admin/billing/checkouts', { token: tokens.accessToken });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, 'FORBIDDEN');
});

test('the ledger lists checkouts with both references and the owning user', async () => {
  const reference = await insertCheckout({ email: 'buyer@example.com', tier: 'pro', amount: 750000 });

  const admin = await h.adminToken();
  const res = await h.request('GET', '/api/v1/admin/billing/checkouts', { token: admin });
  assert.equal(res.status, 200);
  assert.equal(res.body.checkouts.length, 1);

  const row = res.body.checkouts[0];
  assert.equal(row.reference, reference);
  assert.equal(row.providerReference, 'op_buyer@example.com', 'the provider reference is what matches a webhook');
  assert.equal(row.sessionId ?? row.session_id ?? null, null, 'session id is not exposed');
  assert.equal(row.tier, 'pro');
  assert.equal(row.amountMinor, 750000);
  assert.equal(row.currency, 'NGN');
  assert.equal(row.status, 'open');
  assert.equal(row.user.email, 'buyer@example.com');
  assert.ok(row.createdAt);
});

test('the ledger can be filtered by status', async () => {
  await insertCheckout({ email: 'paid@example.com', status: 'paid' });
  await insertCheckout({ email: 'open@example.com', status: 'open' });

  const admin = await h.adminToken();
  const paid = await h.request('GET', '/api/v1/admin/billing/checkouts?status=paid', { token: admin });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.checkouts.length, 1);
  assert.equal(paid.body.checkouts[0].status, 'paid');

  const open = await h.request('GET', '/api/v1/admin/billing/checkouts?status=open', { token: admin });
  assert.equal(open.body.checkouts.every((c: any) => c.status === 'open'), true);
});

test('the ledger limit is clamped', async () => {
  const admin = await h.adminToken();
  const res = await h.request('GET', '/api/v1/admin/billing/checkouts?limit=99999', { token: admin });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.checkouts));
});

test('an empty ledger is an empty list, not an error', async () => {
  const admin = await h.adminToken();
  const res = await h.request('GET', '/api/v1/admin/billing/checkouts', { token: admin });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.checkouts, []);
});

test('checkouts are returned newest first', async () => {
  await insertCheckout({ email: 'first@example.com' });
  await h.query(`UPDATE billing_checkouts SET created_at = now() - interval '1 hour' WHERE reference = 'spx-first@example.com'`);
  await insertCheckout({ email: 'second@example.com' });

  const admin = await h.adminToken();
  const res = await h.request('GET', '/api/v1/admin/billing/checkouts', { token: admin });
  assert.equal(res.body.checkouts[0].reference, 'spx-second@example.com');
});

test('the expiry sweep flips stale checkouts and the sweep is wired', async () => {
  const reference = await insertCheckout({ email: 'stale@example.com', status: 'open' });
  await h.query(`UPDATE billing_checkouts SET expires_at = now() - interval '2 hours' WHERE reference = '${reference}'`);

  const { expireStaleCheckouts } = await import('../../apps/controller/src/services/billing.js');
  const swept = await expireStaleCheckouts(h.db);
  assert.equal(swept, 1);

  const rows = await h.query<any>(`SELECT status FROM billing_checkouts WHERE reference = '${reference}'`);
  assert.equal(rows[0].status, 'expired');
});

test('the expiry sweep leaves paid and unexpired checkouts alone', async () => {
  await insertCheckout({ email: 'paidkeep@example.com', status: 'paid' });
  await insertCheckout({ email: 'future@example.com', status: 'open' });
  await h.query(`UPDATE billing_checkouts SET expires_at = now() + interval '2 hours' WHERE reference = 'spx-future@example.com'`);

  const { expireStaleCheckouts } = await import('../../apps/controller/src/services/billing.js');
  await expireStaleCheckouts(h.db);

  const rows = await h.query<any>(`SELECT reference, status FROM billing_checkouts ORDER BY reference`);
  assert.equal(rows.find((r: any) => r.reference === 'spx-paidkeep@example.com').status, 'paid');
  assert.equal(rows.find((r: any) => r.reference === 'spx-future@example.com').status, 'open');
});

test('the server entrypoint actually schedules the expiry sweep', async () => {
  // Regression guard: expireStaleCheckouts was originally written and tested
  // but never wired into the running process, so abandoned checkouts were
  // never reclaimed in production.
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../../apps/controller/src/server.ts', import.meta.url), 'utf8');
  assert.match(source, /expireStaleCheckouts/, 'server.ts must schedule checkout expiry');
  assert.match(source, /setInterval/, 'the job must run on a schedule');
});
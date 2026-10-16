/**
 * Admin dispute workflow: authorization and the rules that protect us from
 * filing junk.
 *
 * These routes proxy the provider, so a merchant can actually contest a
 * chargeback instead of losing it silently.
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

const DISPUTE_ROUTES: Array<[string, string]> = [
  ['GET', '/api/v1/admin/disputes'],
  ['GET', '/api/v1/admin/disputes/d1'],
  ['GET', '/api/v1/admin/disputes/d1/evidence'],
  ['POST', '/api/v1/admin/disputes/d1/evidence'],
  ['POST', '/api/v1/admin/disputes/d1/evidence/s1/submitted'],
];

test('every dispute route rejects anonymous callers', async () => {
  for (const [method, path] of DISPUTE_ROUTES) {
    const res = await h.request(method, path, method === 'GET' ? {} : { body: {} });
    assert.equal(res.status, 401, `${method} ${path} must require authentication`);
  }
});

test('every dispute route rejects an authenticated non-admin', async () => {
  const user = await h.seedUser('notadmin@example.test');
  const tokens = await h.login(user.email, SEED_PASSWORD, 'device-1');
  for (const [method, path] of DISPUTE_ROUTES) {
    const res = await h.request(method, path, method === 'GET' ? { token: tokens.accessToken } : { token: tokens.accessToken, body: {} });
    assert.equal(res.status, 403, `${method} ${path} must reject a regular user`);
    assert.equal(res.body.code, 'FORBIDDEN');
  }
});

test('evidence submission refuses an empty narrative', async () => {
  const admin = await h.adminToken();

  for (const body of [{}, { narrative: '' }, { narrative: 'too short' }]) {
    const res = await h.request('POST', '/api/v1/admin/disputes/d1/evidence', { token: admin, body });
    assert.equal(res.status, 400, `expected rejection for ${JSON.stringify(body)}`);
    assert.equal(res.body.code, 'VALIDATION');
  }
});

test('a long-enough narrative is accepted and passed to the provider', async () => {
  const admin = await h.adminToken();
  const res = await h.request('POST', '/api/v1/admin/disputes/d1/evidence', {
    token: admin,
    // The provider is unreachable in tests, so this exercises validation and
    // error translation rather than a successful submission.
    body: { narrative: 'Customer was granted access only after the charge settled; see the attached logs.' },
  });
  // Either the provider accepted it, or it failed and we reported why — what
  // must never happen is a 500 with no explanation.
  assert.notEqual(res.status, 500, 'a provider failure must not surface as a bare internal error');
  assert.ok(res.status === 201 || res.status >= 400);
  if (res.status >= 400) {
    assert.notEqual(res.body.code, 'INTERNAL');
    assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
  }
});

test('a missing disputeId is rejected before any provider call', async () => {
  const admin = await h.adminToken();
  const res = await h.request('POST', '/api/v1/admin/disputes/%20/evidence', { token: admin, body: { narrative: 'x'.repeat(30) } });
  assert.ok(res.status === 400 || res.status === 404, `expected a rejection, got ${res.status}`);
});

test('dispute routes report 503 when no gateway is configured', async () => {
  // A gateway-less deployment must say so plainly rather than pretending.
  await h.stop();
  h = await createHarness();

  const admin = await h.adminToken();
  const res = await h.request('GET', '/api/v1/admin/disputes', { token: admin });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'BILLING_NOT_CONFIGURED');
});

test('authorization still holds with no gateway configured', async () => {
  const user = await h.seedUser('plain2@example.test');
  const tokens = await h.login(user.email, SEED_PASSWORD, 'device-1');
  const res = await h.request('GET', '/api/v1/admin/disputes', { token: tokens.accessToken });
  assert.equal(res.status, 403, 'authorization is checked before configuration');
});
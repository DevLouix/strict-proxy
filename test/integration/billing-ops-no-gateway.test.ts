/**
 * Operator billing routes on a deployment with no payment gateway.
 *
 * Its own file because it needs a gateway-less harness, and the harness shares
 * one database pool per process — stopping a second harness would end the pool
 * every other test in this file still needs.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';

let h: Harness;

before(async () => {
  h = await createHarness();
});

after(async () => {
  await h.stop();
});

const ROUTES = [
  ['GET', '/api/v1/admin/billing/providers', undefined],
  ['POST', '/api/v1/admin/billing/providers/test', {}],
  ['POST', '/api/v1/admin/billing/plans/sync', {}],
  ['DELETE', '/api/v1/admin/billing/plans/price/standard', undefined],
  ['POST', '/api/v1/admin/billing/plans/delete', { planId: 'x' }],
  ['GET', '/api/v1/admin/billing/subscriptions', undefined],
  ['POST', '/api/v1/admin/billing/subscriptions/cancel', { userId: 'x' }],
] as const;

test('every operator billing route reports that the gateway is unconfigured', async () => {
  const admin = await h.adminToken();
  for (const [method, path, body] of ROUTES) {
    const res = await h.request(method, path, { token: admin, body });
    assert.equal(res.status, 503, `${method} ${path}: ${res.status}`);
    assert.equal(res.body.code, 'BILLING_NOT_CONFIGURED', path);
  }
});

test('admin-only is still enforced without a gateway', async () => {
  // The auth check has to come first: an unauthenticated caller must learn
  // nothing about whether a gateway is configured.
  const user = await h.seedUser('plain@example.test');
  const tokens = await h.login(user.email, user.password, 'device-1');
  for (const [method, path, body] of ROUTES) {
    assert.equal((await h.request(method, path, { body })).status, 401, path);
    assert.equal((await h.request(method, path, { token: tokens.accessToken, body })).status, 403, path);
  }
});

// Pricing is catalogue data, not gateway data: it has to be settable before a
// provider key exists, and readable while the provider is down. This is what
// used to 503, which left the dashboard with nowhere to set an amount.
test('prices can be read and set without a gateway', async () => {
  const admin = await h.adminToken();

  const plans = await h.request('GET', '/api/v1/admin/billing/plans', { token: admin });
  assert.equal(plans.status, 200);
  assert.equal(plans.body.gateway, 'unconfigured');
  assert.deepEqual(plans.body.providerPlans, []);
  assert.ok(plans.body.tiers.length > 0, 'the tiers and their prices are still listed');
  assert.ok(plans.body.currencies.some((c: { code: string }) => c.code === 'NGN'));

  const put = await h.request('PUT', '/api/v1/admin/billing/plans/price', {
    token: admin,
    body: { tier: 'standard', amountMinor: 550 },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.needsSync, true, 'there is no provider plan to reprice yet');
  assert.equal(put.body.providerUpdated, false);

  const catalog = await h.request('GET', '/api/v1/billing/catalog', { token: admin });
  const standard = (catalog.body.tiers as { tier: string; price: { amountMinor: number } }[])
    .find((t) => t.tier === 'standard');
  assert.equal(standard!.price.amountMinor, 550, 'the stored price is what checkout will charge');
});

/**
 * Billing currency and prices are operator settings, not deploy-time constants.
 *
 * The environment stays the default so an existing installation keeps charging
 * what it charged before; the value in use is stored in `platform_settings` and
 * changed from the dashboard. The thing that must never break is agreement: the
 * price the catalogue advertises, the price a checkout is opened for, and the
 * currency they are expressed in all come from one place.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';
import { createTierCheckout } from '../../apps/controller/src/services/billing.js';

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

test('the currency defaults to the deployment value and is admin-editable', async () => {
  const admin = await h.adminToken();

  const initial = await h.request('GET', '/api/v1/admin/billing/settings', { token: admin });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.currency, h.cfg.billingCurrency);
  assert.equal(initial.body.defaultCurrency, h.cfg.billingCurrency);
  assert.equal(initial.body.currencyOverridden, false);
  assert.equal(initial.body.minorUnits, true);
  assert.ok(initial.body.tiers.length > 0);

  const put = await h.request('PUT', '/api/v1/admin/billing/settings', {
    token: admin,
    body: { currency: 'ngn' },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.currency, 'NGN', 'the code is normalised to uppercase');
  assert.equal(put.body.previousCurrency, h.cfg.billingCurrency);

  const after = await h.request('GET', '/api/v1/admin/billing/settings', { token: admin });
  assert.equal(after.body.currency, 'NGN');
  assert.equal(after.body.defaultCurrency, h.cfg.billingCurrency);
  assert.equal(after.body.currencyOverridden, true);
  for (const tier of after.body.tiers) {
    assert.equal(tier.currency, 'NGN');
    // A currency change must not touch the amount.
    assert.equal(tier.amountMinor, tier.configuredAmountMinor);
  }
});

test('the public catalogue advertises the admin currency', async () => {
  const admin = await h.adminToken();
  await h.request('PUT', '/api/v1/admin/billing/settings', { token: admin, body: { currency: 'eur' } });

  const catalog = await h.request('GET', '/api/v1/billing/catalog', { token: admin });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.currency, 'EUR');
  for (const entry of catalog.body.tiers) {
    assert.equal(entry.price.currency, 'EUR');
  }
});

test('a checkout is opened in the admin currency, not the configured one', async () => {
  const admin = await h.adminToken();
  await h.request('PUT', '/api/v1/admin/billing/settings', { token: admin, body: { currency: 'NGN' } });
  const user = await h.seedUser('buyer@example.test');

  const sessions: Array<Record<string, unknown>> = [];
  const gateway = {
    checkout: {
      create: async (params: Record<string, unknown>) => {
        sessions.push(params);
        return { reference: 'ref_1', session_id: 'sess_1', checkout_url: 'https://pay.test/x' };
      },
    },
  };

  const checkout = await createTierCheckout(
    h.db,
    h.cfg,
    { userId: user.id, email: user.email, tier: 'standard' },
    gateway as never,
  );

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.currency, 'NGN', 'the provider is asked for the currency the catalogue shows');
  assert.equal(sessions[0]!.amount, checkout.amountMinor);
  assert.equal(checkout.currency, 'NGN');
  assert.equal(checkout.amountMinor, h.cfg.billingStandardAmountMinor, 'the amount is untouched');
});

test('a currency that is not an ISO code is refused', async () => {
  const admin = await h.adminToken();
  for (const bad of ['dollars', 'US', '1234', '', 12]) {
    const res = await h.request('PUT', '/api/v1/admin/billing/settings', { token: admin, body: { currency: bad } });
    assert.equal(res.status, 400, `expected ${JSON.stringify(bad)} to be refused`);
    assert.equal(res.body.code, 'VALIDATION');
  }

  const missing = await h.request('PUT', '/api/v1/admin/billing/settings', { token: admin, body: {} });
  assert.equal(missing.status, 400);

  // A refused change leaves the previous currency in place.
  const settings = await h.request('GET', '/api/v1/admin/billing/settings', { token: admin });
  assert.equal(settings.body.currency, h.cfg.billingCurrency);
});

test('the billing settings are administrator-only', async () => {
  const user = await h.seedUser('no-settings@example.test');
  const tokens = await h.login(user.email, user.password, 'device-1');

  const read = await h.request('GET', '/api/v1/admin/billing/settings', { token: tokens.accessToken });
  assert.equal(read.status, 403);
  const write = await h.request('PUT', '/api/v1/admin/billing/settings', {
    token: tokens.accessToken,
    body: { currency: 'NGN' },
  });
  assert.equal(write.status, 403);
});

test('each currency keeps its own price', async () => {
  const admin = await h.adminToken();
  const standard = async () => {
    const settings = await h.request('GET', '/api/v1/admin/billing/settings', { token: admin });
    return (settings.body.tiers as Array<{ tier: string; amountMinor: number; currency: string }>)
      .find((tier) => tier.tier === 'standard')!;
  };

  await h.request('PUT', '/api/v1/admin/billing/settings', { token: admin, body: { currency: 'USD' } });
  const saved = await h.request('PUT', '/api/v1/admin/billing/settings', {
    token: admin,
    body: { amounts: { standard: 500 } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.currency, 'USD');
  assert.equal(saved.body.applied[0].tier, 'standard');
  assert.equal((await standard()).amountMinor, 500);

  await h.request('PUT', '/api/v1/admin/billing/settings', { token: admin, body: { currency: 'NGN' } });
  // NGN starts from the deployment default, not from the USD amount: a price is
  // not a number that can be reinterpreted in another currency.
  assert.equal((await standard()).amountMinor, h.cfg.billingStandardAmountMinor);

  await h.request('PUT', '/api/v1/admin/billing/settings', {
    token: admin,
    body: { amounts: { standard: 300000 } },
  });
  assert.equal((await standard()).amountMinor, 300000);

  await h.request('PUT', '/api/v1/admin/billing/settings', { token: admin, body: { currency: 'USD' } });
  assert.equal((await standard()).amountMinor, 500, 'the USD price survived the round trip');
});

test('the symbol travels with the currency', async () => {
  const admin = await h.adminToken();
  const settings = await h.request('GET', '/api/v1/admin/billing/settings', { token: admin });
  assert.equal(settings.body.symbol, '$');

  const currencies = settings.body.currencies as Array<{ code: string; symbol: string }>;
  assert.ok(currencies.length > 1, 'the dashboard needs a list to choose from');
  assert.equal(currencies.find((c) => c.code === 'NGN')!.symbol, '₦');
});

test('amounts are validated before anything is stored', async () => {
  const admin = await h.adminToken();
  const before = await h.request('GET', '/api/v1/admin/billing/settings', { token: admin });
  const configured = (before.body.tiers as Array<{ tier: string; configuredAmountMinor: number }>)
    .find((tier) => tier.tier === 'pro')!.configuredAmountMinor;

  for (const amounts of [{ standard: 0 }, { standard: -1 }, { standard: 1.5 }, { standard: '100' }, { nope: 100 }]) {
    const res = await h.request('PUT', '/api/v1/admin/billing/settings', { token: admin, body: { amounts } });
    assert.equal(res.status, 400, `expected ${JSON.stringify(amounts)} to be refused`);
  }

  // A partially valid payload must not half-apply: `pro` stays at its default.
  const mixed = await h.request('PUT', '/api/v1/admin/billing/settings', {
    token: admin,
    body: { amounts: { standard: 900, pro: -5 } },
  });
  assert.equal(mixed.status, 400);
  const after = await h.request('GET', '/api/v1/admin/billing/settings', { token: admin });
  assert.equal(
    (after.body.tiers as Array<{ tier: string; amountMinor: number }>).find((tier) => tier.tier === 'pro')!.amountMinor,
    configured,
  );
});


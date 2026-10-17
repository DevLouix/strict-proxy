/**
 * Operator-set plan prices.
 *
 * A price is the one number in this platform that must never be wrong: it is
 * what a customer is charged. These tests pin that an override reaches the
 * checkout, that it reaches the provider plan, and — most importantly — that a
 * failed provider update leaves the deployment charging what it charged before
 * rather than advertising a price it cannot bill.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';
import {
  priceForTier,
  purchasableTiers,
  BillingError,
} from '../../apps/controller/src/services/catalog.js';
import {
  loadPriceOverrides,
  setPriceOverride,
  validatePriceAmount,
  priceOverrideKey,
  effectivePrice,
  configuredAmount,
} from '../../apps/controller/src/services/pricing.js';
import { setTierPlanPrice, ensureTierPlan } from '../../apps/controller/src/services/plans.js';
import { createTierCheckout } from '../../apps/controller/src/services/billing.js';

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

/** The admin whose id is recorded against a price change. */
async function anAdmin(): Promise<string> {
  return (await h.seedUser('price-admin@example.test', 'admin')).id;
}

const MERCHANT = '11111111-1111-1111-1111-111111111111';
const APP = '22222222-2222-2222-2222-222222222222';

interface PlanRecord {
  id: string;
  merchant_id: string;
  name: string;
  amount: number;
  currency: string;
  interval_unit: string;
  interval_count: number;
  status: string;
  metadata: Record<string, unknown>;
}

/** Provider stub carrying just what the price paths touch. */
function stubProvider(plans: PlanRecord[] = []) {
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const checkouts: Record<string, unknown>[] = [];
  let seq = 0;

  const client = {
    subscriptions: {
      listPlans: async () => ({ data: plans.map((p) => ({ ...p })) }),
      getPlan: async (id: string) => {
        const found = plans.find((p) => p.id === id);
        if (!found) throw Object.assign(new Error('Plan not found'), { status: 404, name: 'OpenPayError' });
        return { ...found };
      },
      createPlan: async (params: Record<string, unknown>) => {
        const created: PlanRecord = {
          id: `plan_${++seq}`,
          merchant_id: String(params.merchant_id),
          name: String(params.name),
          amount: Number(params.amount),
          currency: String(params.currency),
          interval_unit: String(params.interval_unit),
          interval_count: Number(params.interval_count ?? 1),
          status: 'active',
          metadata: (params.metadata as Record<string, unknown>) ?? {},
        };
        plans.push(created);
        return { ...created };
      },
      updatePlan: async (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        const found = plans.find((p) => p.id === id);
        if (!found) throw Object.assign(new Error('Plan not found'), { status: 404, name: 'OpenPayError' });
        const next = { ...found, ...patch } as PlanRecord;
        plans[plans.indexOf(found)] = next;
        return { ...next };
      },
    },
    apps: { list: async () => ({ data: [{ id: APP, merchant_id: MERCHANT }] }) },
    checkout: {
      create: async (params: Record<string, unknown>) => {
        checkouts.push(params);
        return { reference: `ref_${checkouts.length}`, session_id: `sess_${checkouts.length}`, checkout_url: 'https://pay.test/x' };
      },
    },
  };

  return { client: client as never, plans, updates, checkouts };
}

// ---------------------------------------------------------------------------
// Reading and writing the override
// ---------------------------------------------------------------------------

test('with no override set, the configured price is used', async () => {
  const overrides = await loadPriceOverrides(h.db, h.cfg);
  assert.deepEqual(overrides, {});
  assert.equal(priceForTier(h.cfg, 'standard', overrides).amountMinor, h.cfg.billingStandardAmountMinor);
});

test('an override replaces the configured amount, and only the amount', async () => {
  await setPriceOverride(h.db, h.cfg, 'standard', 300000);
  const overrides = await loadPriceOverrides(h.db, h.cfg);

  const price = priceForTier(h.cfg, 'standard', overrides);
  assert.equal(price.amountMinor, 300000);
  assert.equal(price.currency, h.cfg.billingCurrency, 'the currency stays deployment configuration');
  assert.equal(price.label, 'Standard', 'and so does the label');

  // The tier that was not overridden is untouched.
  assert.equal(priceForTier(h.cfg, 'pro', overrides).amountMinor, h.cfg.billingProAmountMinor);
});

test('resetting a tier goes back to the configured price, at the provider too', async () => {
  // Not "delete the override": that would leave the catalogue advertising the
  // configured price while the provider plan kept billing the overridden one.
  const stub = stubProvider();
  await ensureTierPlan(h.db, h.cfg, stub.client, 'pro');
  await setTierPlanPrice(h.db, h.cfg, stub.client, 'pro', 999999);
  assert.equal(stub.plans[0]!.amount, 999999);

  const back = await setTierPlanPrice(h.db, h.cfg, stub.client, 'pro', configuredAmount(h.cfg, 'pro'));
  assert.equal(back.amountMinor, h.cfg.billingProAmountMinor);
  assert.equal(stub.plans[0]!.amount, h.cfg.billingProAmountMinor, 'the provider follows the reset');
  assert.equal(effectivePrice(h.cfg, await loadPriceOverrides(h.db, h.cfg), 'pro'), h.cfg.billingProAmountMinor);
});

test('a corrupted stored override falls back to the configured price instead of breaking checkout', async () => {
  // A bad row must not take the whole pricing surface down with it: the fallback
  // is exactly what the deployment would charge with no override at all.
  for (const bad of ['not json', '{}', '{"amountMinor":0}', '{"amountMinor":-5}', '{"amountMinor":1.5}', '{"amountMinor":"250000"}']) {
    await h.query(`INSERT INTO platform_settings (key, value) VALUES ('${priceOverrideKey('standard')}', '${bad}')
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const overrides = await loadPriceOverrides(h.db, h.cfg);
    assert.equal(overrides.standard, undefined, `${bad} must not be accepted as a price`);
    assert.equal(priceForTier(h.cfg, 'standard', overrides).amountMinor, h.cfg.billingStandardAmountMinor);
  }
});

test('the sorted tier list follows the overridden prices, not the configured ones', async () => {
  // The catalogue is ordered cheapest-first, so an override can legitimately
  // change the order the tiers are presented in.
  await setPriceOverride(h.db, h.cfg, 'standard', 9_000_000);
  const order = purchasableTiers(h.cfg, await loadPriceOverrides(h.db, h.cfg)).map((t) => t.tier);
  assert.deepEqual(order, ['pro', 'standard']);
});

test('an amount must be a positive integer of minor units', () => {
  assert.equal(validatePriceAmount(1), 1);
  assert.equal(validatePriceAmount(250000), 250000);
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '250000', null, undefined, {}]) {
    assert.throws(() => validatePriceAmount(bad), BillingError, `${String(bad)} must be rejected`);
  }
});

test('a tier the deployment does not sell cannot be priced', async () => {
  await assert.rejects(() => setPriceOverride(h.db, h.cfg, 'free', 1000), BillingError);
});

test('the effective price prefers the override and falls back to the configuration', () => {
  assert.equal(effectivePrice(h.cfg, {}, 'standard'), h.cfg.billingStandardAmountMinor);
  assert.equal(effectivePrice(h.cfg, { standard: 123 }, 'standard'), 123);
});

// ---------------------------------------------------------------------------
// Changing a price: provider plan and catalogue together
// ---------------------------------------------------------------------------

test('changing a price updates the provider plan and the catalogue', async () => {
  const stub = stubProvider();
  await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');

  const change = await setTierPlanPrice(h.db, h.cfg, stub.client, 'standard', 400000, await anAdmin());
  assert.equal(change.providerUpdated, true);
  assert.equal(change.needsSync, false);
  assert.equal(change.previousAmountMinor, h.cfg.billingStandardAmountMinor);

  // The provider really was told, with the new amount.
  assert.equal(stub.updates.length, 1);
  assert.equal(stub.updates[0]!.patch.amount, 400000);
  assert.equal(stub.plans[0]!.amount, 400000);

  // And the catalogue agrees, so the next checkout charges the same thing.
  assert.equal(effectivePrice(h.cfg, await loadPriceOverrides(h.db, h.cfg), 'standard'), 400000);
});

test('a failed provider update leaves the price unchanged rather than half-applied', async () => {
  // Critical: advertising a price the provider cannot bill is worse than
  // refusing the change. The catalogue must not move if the plan did not.
  const stub = stubProvider();
  await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  const before = stub.plans[0]!.amount;
  stub.client.subscriptions.updatePlan = async () => {
    throw Object.assign(new Error('Provider API error (500)'), { status: 500, name: 'OpenPayError' });
  };

  await assert.rejects(
    () => setTierPlanPrice(h.db, h.cfg, stub.client, 'standard', 400000),
    /500/,
  );

  assert.equal(stub.plans[0]!.amount, before, 'the plan is unchanged');
  const overrides = await loadPriceOverrides(h.db, h.cfg);
  assert.equal(overrides.standard, undefined, 'and so is the catalogue');
  assert.equal(effectivePrice(h.cfg, overrides, 'standard'), h.cfg.billingStandardAmountMinor);
});

test('a tier with no plan yet records the price and asks for a sync', async () => {
  const stub = stubProvider();
  const change = await setTierPlanPrice(h.db, h.cfg, stub.client, 'pro', 800000);

  assert.equal(change.providerUpdated, false);
  assert.equal(change.needsSync, true, 'nothing can be billed until a plan exists');
  assert.equal(change.planId, null);
  // The price is still recorded: the next sync creates the plan at this amount.
  assert.equal(effectivePrice(h.cfg, await loadPriceOverrides(h.db, h.cfg), 'pro'), 800000);

  const created = await ensureTierPlan(h.db, h.cfg, stub.client, 'pro');
  assert.equal(created.actualAmountMinor, 800000, 'the plan is created at the overridden price');
});

test('a plan that cannot be sold is not repriced, and a sync is requested instead', async () => {
  const stub = stubProvider();
  await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  stub.plans[0]!.status = 'archived';

  const change = await setTierPlanPrice(h.db, h.cfg, stub.client, 'standard', 400000);
  assert.equal(change.providerUpdated, false, 'repricing a plan nobody can buy achieves nothing');
  assert.equal(change.needsSync, true);
  assert.equal(stub.updates.length, 0);
});

test('the change records which admin made it', async () => {
  const stub = stubProvider();
  const admin = await anAdmin();
  await setTierPlanPrice(h.db, h.cfg, stub.client, 'standard', 400000, admin);
  const [row] = await h.query<{ updated_by: string }>(
    `SELECT updated_by FROM platform_settings WHERE key = '${priceOverrideKey('standard')}'`,
  );
  assert.equal(row.updated_by, admin, 'a price change must be attributable to a person');
});

// ---------------------------------------------------------------------------
// The point of all of it: what the customer is charged
// ---------------------------------------------------------------------------

test('a checkout opened after a price change charges the new amount', async () => {
  const stub = stubProvider();
  const user = await h.seedUser('buyer@example.test');

  const before = await createTierCheckout(
    h.db, h.cfg,
    { userId: user.id, email: user.email, tier: 'standard' },
    stub.client,
  );
  assert.equal(before.amountMinor, h.cfg.billingStandardAmountMinor);

  await setTierPlanPrice(h.db, h.cfg, stub.client, 'standard', 330000, await anAdmin());

  const after = await createTierCheckout(
    h.db, h.cfg,
    { userId: user.id, email: user.email, tier: 'standard' },
    stub.client,
  );
  assert.equal(after.amountMinor, 330000, 'the price the catalogue advertises is the price charged');

  // The provider was asked for the new amount, and the ledger records it too.
  assert.equal(stub.checkouts.at(-1).amount, 330000);
  const [row] = await h.query<{ amount_minor: number }>(
    `SELECT amount_minor FROM billing_checkouts ORDER BY created_at DESC LIMIT 1`,
  );
  assert.equal(row.amount_minor, 330000);
});

test('the public catalogue reflects an override, so the client advertises the real price', async () => {
  const user = await h.seedUser('catalog@example.test');
  const tokens = await h.login(user.email, user.password, 'device-1');
  await setPriceOverride(h.db, h.cfg, 'standard', 330000);

  const res = await h.request('GET', '/api/v1/billing/catalog', { token: tokens.accessToken });
  assert.equal(res.status, 200);
  const standard = (res.body.tiers as { tier: string; price: { amountMinor: number } }[])
    .find((t) => t.tier === 'standard');
  assert.equal(standard!.price.amountMinor, 330000, 'the client must not advertise a stale price');
});

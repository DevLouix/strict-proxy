/**
 * Operator billing actions: plan provisioning and subscription cancellation.
 *
 * Plans used to be created by hand in the provider dashboard, which meant the
 * catalog prices and the prices actually billed could drift apart with nothing
 * noticing. These tests pin that plans are provisioned from the catalog, reused
 * rather than duplicated, and that a drifted price is reported instead of
 * silently pushed.
 *
 * The provider is stubbed. These tests are about our behaviour — what we call,
 * what we cache and what we report — not about the provider's, which is covered
 * by the live contract tests.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';
import { syncTierPlans, ensureTierPlan, findTierPlan, removeTierPlan, setMerchantId, isOurPlan, isUsablePlan } from '../../apps/controller/src/services/plans.js';
import { MERCHANT_SETTING_KEY } from '../../apps/controller/src/services/plans.js';
import { httpStatusOf } from '../../apps/controller/src/services/openpay.js';

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

interface StubCall {
  method: string;
  args: unknown;
}

/**
 * A minimal stand-in for the provider's plans surface.
 *
 * Models the three behaviours that matter: `createPlan` rejects a missing
 * merchant_id (verified live), `getPlan` 404s for an unknown id, and
 * `deletePlan` archives rather than deletes when billing history references the
 * plan (documented by the SDK's `PlanDeleteResult`, verified live).
 */
function stubProvider(
  opts: { plans?: PlanRecord[]; apps?: { id: string; merchant_id: string }[]; referenced?: string[] } = {},
) {
  const plans: PlanRecord[] = [...(opts.plans ?? [])];
  const apps = opts.apps ?? [{ id: APP, merchant_id: MERCHANT }];
  const calls: StubCall[] = [];
  // Plan ids the provider refuses to drop because charges point at them.
  const referenced = new Set(opts.referenced ?? []);
  let seq = 0;

  const client = {
    subscriptions: {
      listPlans: async () => {
        calls.push({ method: 'listPlans', args: null });
        return { data: plans.map((p) => ({ ...p })) };
      },
      getPlan: async (id: string) => {
        calls.push({ method: 'getPlan', args: id });
        const found = plans.find((p) => p.id === id);
        if (!found) {
          const err = Object.assign(new Error('Plan not found'), { status: 404, name: 'OpenPayError' });
          throw err;
        }
        return { ...found };
      },
      createPlan: async (params: Record<string, unknown>) => {
        calls.push({ method: 'createPlan', args: params });
        // The provider requires this; omitting it fails validation.
        if (typeof params.merchant_id !== 'string') {
          const err = Object.assign(new Error('Validation failed'), { status: 400, name: 'OpenPayError' });
          throw err;
        }
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
      deletePlan: async (id: string) => {
        calls.push({ method: 'deletePlan', args: id });
        const idx = plans.findIndex((p) => p.id === id);
        if (idx === -1) {
          const err = Object.assign(new Error('Plan not found'), { status: 404, name: 'OpenPayError' });
          throw err;
        }
        if (referenced.has(id)) {
          // Billing history references it, so the record survives as an archive.
          plans[idx] = { ...plans[idx]!, status: 'archived' };
          return {
            id,
            deleted: false,
            archived: true,
            plan: { ...plans[idx]! },
            note: 'Plan archived because existing charges reference it.',
          };
        }
        plans.splice(idx, 1);
        return { id, deleted: true, archived: false, note: 'Plan deleted.' };
      },
    },
    apps: {
      list: async () => {
        calls.push({ method: 'apps.list', args: null });
        return { data: apps };
      },
    },
  };

  return { client: client as never, plans, calls, countOf: (m: string) => calls.filter((c) => c.method === m).length };
}

// ---------------------------------------------------------------------------
// Tagging
// ---------------------------------------------------------------------------

test('a plan we created is recognisable as ours', () => {
  assert.equal(isOurPlan({ metadata: { strict_proxy_source: 'strict-proxy' } }), true);
  assert.equal(isOurPlan({ metadata: {} }), false);
  assert.equal(isOurPlan({ metadata: null }), false);
  assert.equal(isOurPlan({}), false);
});

test('an archived plan is flagged as unusable, not as a live one', () => {
  // A delete leaves an archived plan behind when history references it. That is
  // what `deletePlan` documents, so an archived plan has to read as "cannot be
  // subscribed to" rather than merely "a plan with an odd status".
  assert.equal(isUsablePlan({ status: 'active' }), true);
  assert.equal(isUsablePlan({ status: 'archived' }), false);
  assert.equal(isUsablePlan({ status: 'deleted' }), false);
  assert.equal(isUsablePlan({ status: 'inactive' }), false);
  assert.equal(isUsablePlan({ status: 'ARCHIVED' }), false, 'case must not matter');
  assert.equal(isUsablePlan({}), true, 'a plan with no status is not assumed unusable');
});

test('a plan archived by a delete is replaced, and the replacement is reported', async () => {
  // An archived plan can never be sold again, and its tier tag still matches, so
  // without a replacement the tier would be stuck finding a dead plan forever.
  const stub = stubProvider();
  stub.plans.push({
    id: 'plan_archived', merchant_id: MERCHANT, name: 'StrictProxy Standard (standard)',
    amount: 250000, currency: 'NGN', interval_unit: 'month', interval_count: 1, status: 'archived',
    metadata: { strict_proxy_tier: 'standard', strict_proxy_source: 'strict-proxy' },
  });

  const result = await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  assert.equal(result.created, true, 'the dead plan cannot be sold, so the tier needs a new one');
  assert.equal(result.usable, true);
  assert.equal(result.replacedPlanId, 'plan_archived', 'and the operator is told what it replaced');
  assert.notEqual(result.planId, 'plan_archived');
  assert.equal(stub.plans.length, 2, 'the dead plan is left as billing history, not removed');
});

test('a deactivated plan is left alone, because switching it off may be deliberate', async () => {
  // Unlike an archive, `inactive` is a decision someone made. Creating a second
  // plan over it would override that, so it is reported and nothing is created.
  const stub = stubProvider();
  stub.plans.push({
    id: 'plan_inactive', merchant_id: MERCHANT, name: 'StrictProxy Standard (standard)',
    amount: 250000, currency: 'NGN', interval_unit: 'month', interval_count: 1, status: 'inactive',
    metadata: { strict_proxy_tier: 'standard', strict_proxy_source: 'strict-proxy' },
  });

  const result = await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  assert.equal(result.created, false);
  assert.equal(result.usable, false, 'the operator must be able to see this is not sellable');
  assert.equal(result.status, 'inactive');
  assert.equal(result.replacedPlanId, null);
  assert.equal(stub.countOf('createPlan'), 0, 'no plan is created over an operator decision');
});

test('a live plan is still preferred when a dead one shares its tier tag', async () => {
  // Both tags match, so the choice must not depend on the provider's list order.
  const stub = stubProvider();
  stub.plans.push({
    id: 'plan_dead', merchant_id: MERCHANT, name: 'StrictProxy Standard (standard)',
    amount: 250000, currency: 'NGN', interval_unit: 'month', interval_count: 1, status: 'archived',
    metadata: { strict_proxy_tier: 'standard', strict_proxy_source: 'strict-proxy' },
  });
  stub.plans.push({
    id: 'plan_live', merchant_id: MERCHANT, name: 'StrictProxy Standard (standard)',
    amount: 250000, currency: 'NGN', interval_unit: 'month', interval_count: 1, status: 'active',
    metadata: { strict_proxy_tier: 'standard', strict_proxy_source: 'strict-proxy' },
  });

  const result = await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  assert.equal(result.planId, 'plan_live');
  assert.equal(result.created, false);
  assert.equal(stub.countOf('createPlan'), 0);
});

// ---------------------------------------------------------------------------
// Merchant resolution
// ---------------------------------------------------------------------------

test('the merchant id is derived from the app record', async () => {
  // `merchants.list` returns child merchants under the account, not the caller,
  // so it is not usable here. The app record carries the right id.
  const stub = stubProvider();
  await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');

  const stored = await h.query<any>(`SELECT value FROM platform_settings WHERE key = '${MERCHANT_SETTING_KEY}'`);
  assert.equal(stored[0].value, MERCHANT);
});

test('an operator-supplied merchant id wins over the derived one', async () => {
  const stub = stubProvider();
  await setMerchantId(h.db, h.cfg, 'override-merchant');
  await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');

  const created = stub.calls.find((c) => c.method === 'createPlan');
  assert.equal((created!.args as Record<string, unknown>).merchant_id, 'override-merchant');
  assert.equal(stub.countOf('apps.list'), 0, 'no derivation is attempted when an override exists');
});

test('a missing merchant id fails with actionable advice', async () => {
  const stub = stubProvider({ apps: [], plans: [] });
  await assert.rejects(
    () => ensureTierPlan(h.db, h.cfg, stub.client, 'standard'),
    /merchantId/,
    'the error must say how to fix it',
  );
});

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

test('a plan is created from the catalog price', async () => {
  const stub = stubProvider();
  const result = await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');

  assert.equal(result.created, true);
  assert.equal(result.expectedAmountMinor, h.cfg.billingStandardAmountMinor);
  assert.equal(result.actualAmountMinor, h.cfg.billingStandardAmountMinor);
  assert.equal(result.priceMismatch, false);
  assert.equal(result.interval, '1 month');
  assert.equal(result.currency, h.cfg.billingCurrency);

  const params = stub.calls.find((c) => c.method === 'createPlan')!.args as Record<string, unknown>;
  assert.equal(params.amount, h.cfg.billingStandardAmountMinor);
  assert.equal(params.interval_unit, 'month');
  assert.equal(params.currency, h.cfg.billingCurrency);
});

test('a plan is tagged with its tier so it can be found again', async () => {
  const stub = stubProvider();
  const result = await ensureTierPlan(h.db, h.cfg, stub.client, 'pro');

  const params = stub.calls.find((c) => c.method === 'createPlan')!.args as Record<string, unknown>;
  const metadata = params.metadata as Record<string, unknown>;
  assert.equal(metadata.strict_proxy_tier, 'pro');
  assert.equal(metadata.strict_proxy_source, 'strict-proxy');
  assert.ok(result.planId);
});

test('an existing plan is reused, not duplicated', async () => {
  const stub = stubProvider();
  await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  const second = await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');

  assert.equal(second.created, false);
  assert.equal(stub.countOf('createPlan'), 1, 'a second call must not create a second plan');
  assert.equal(stub.plans.length, 1);
});

test('a plan is rediscovered by its tier tag when the cache is lost', async () => {
  const stub = stubProvider();
  const first = await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');

  // Simulate losing platform_settings (a restore, a wiped cache, a new host).
  await h.query(`DELETE FROM platform_settings`);

  const second = await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  assert.equal(second.planId, first.planId, 'the same plan must be found without the cache');
  assert.equal(stub.countOf('createPlan'), 1, 'discovery must not create a duplicate');
});

test("another tier's plan is never adopted", async () => {
  const stub = stubProvider();
  await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  await h.query(`DELETE FROM platform_settings`);

  await ensureTierPlan(h.db, h.cfg, stub.client, 'pro');
  assert.equal(stub.plans.length, 2, 'each tier gets its own plan');
  assert.equal(stub.plans.filter((p) => p.metadata.strict_proxy_tier === 'pro').length, 1);
});

test("a plan we did not create is not adopted", async () => {
  // A hand-made plan must never be silently claimed, or a price an operator set
  // by hand would start being overwritten by our catalog.
  const foreign: PlanRecord = {
    id: 'plan_foreign',
    merchant_id: MERCHANT,
    name: 'Handmade Standard',
    amount: 999_999,
    currency: 'NGN',
    interval_unit: 'month',
    interval_count: 1,
    status: 'active',
    metadata: {},
  };
  const stub = stubProvider({ plans: [foreign] });

  const result = await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  assert.equal(result.created, true, 'an untagged plan is not ours to use');
  assert.notEqual(result.planId, 'plan_foreign');
  assert.equal(stub.plans.length, 2);
});

test('a deleted plan is rebuilt rather than reused', async () => {
  const stub = stubProvider();
  const first = await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');

  // Plan removed at the provider, cache still pointing at it.
  stub.plans.length = 0;
  const second = await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');

  assert.equal(second.created, true);
  assert.notEqual(second.planId, first.planId);
});

test('a price that drifted from the catalog is reported, not pushed', async () => {
  const stub = stubProvider();
  await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  // Someone edits the plan at the provider.
  stub.plans[0]!.amount = 111_111;

  const result = await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  assert.equal(result.priceMismatch, true);
  assert.equal(result.expectedAmountMinor, h.cfg.billingStandardAmountMinor);
  assert.equal(result.actualAmountMinor, 111_111);
  assert.equal(stub.countOf('createPlan'), 1, 'a live plan must never be silently repriced');
});

test('a deactivated plan is surfaced rather than replaced', async () => {
  const stub = stubProvider();
  await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  stub.plans[0]!.status = 'inactive';

  const result = await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  assert.equal(result.status, 'inactive', 'the operator must be able to see this');
  assert.equal(result.created, false, 'creating a second plan would not fix a deactivated one');
});

test('a plan get that fails for another reason is surfaced, not treated as absent', async () => {
  const stub = stubProvider();
  await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  stub.client.subscriptions.getPlan = async () => {
    throw Object.assign(new Error('Provider API error (500)'), { status: 500, name: 'OpenPayError' });
  };

  await assert.rejects(() => ensureTierPlan(h.db, h.cfg, stub.client, 'standard'), /500/);
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

test('sync provisions every purchasable tier', async () => {
  const stub = stubProvider();
  const { plans, errors } = await syncTierPlans(h.db, h.cfg, stub.client);

  assert.deepEqual(errors, []);
  assert.deepEqual(plans.map((p) => p.tier).sort(), ['pro', 'standard']);
  assert.equal(plans.every((p) => p.created), true);
});

test('sync is idempotent', async () => {
  const stub = stubProvider();
  await syncTierPlans(h.db, h.cfg, stub.client);
  const second = await syncTierPlans(h.db, h.cfg, stub.client);

  assert.equal(second.plans.filter((p) => p.created).length, 0);
  assert.equal(stub.countOf('createPlan'), 2, 'exactly one plan per tier, ever');
});

test('one tier failing does not stop the others', async () => {
  const stub = stubProvider();
  const original = stub.client.subscriptions.createPlan;
  let calls = 0;
  stub.client.subscriptions.createPlan = async (params: Record<string, unknown>) => {
    calls++;
    // Fail only the cheapest tier (standard is created first).
    if (String(params.name).includes('Standard')) throw new Error('rate limited');
    return original(params);
  };

  const { plans, errors } = await syncTierPlans(h.db, h.cfg, stub.client);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.tier, 'standard');
  assert.equal(errors[0]!.error, 'rate limited');
  assert.equal(plans.some((p) => p.tier === 'pro'), true, 'pro must still be provisioned');
});

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

test('removing a plan deletes it and clears the tier that pointed at it', async () => {
  const stub = stubProvider();
  const [standard] = (await syncTierPlans(h.db, h.cfg, stub.client)).plans;

  const result = await removeTierPlan(h.db, h.cfg, stub.client, standard!.planId);
  assert.equal(result.deleted, true);
  assert.equal(result.archived, false);
  assert.deepEqual(result.forgottenTiers, ['standard'], 'the cache must not keep pointing at a deleted plan');
  assert.equal(stub.plans.some((p) => p.id === standard!.planId), false);

  // And a sync after that provisions a fresh plan rather than trusting the cache.
  const after = await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  assert.equal(after.created, true);
  assert.notEqual(after.planId, standard!.planId);
});

test('a plan the provider keeps as an archive is reported, not presented as a delete', async () => {
  // The provider archives instead of deleting when charging history references
  // the plan. Reporting that as a clean delete would hide the fact that the tier
  // now has no sellable plan.
  const stub = stubProvider();
  const [standard] = (await syncTierPlans(h.db, h.cfg, stub.client)).plans;
  const archivedStub = stubProvider({ plans: stub.plans, referenced: [standard!.planId] });

  const result = await removeTierPlan(h.db, h.cfg, archivedStub.client, standard!.planId);
  assert.equal(result.deleted, false);
  assert.equal(result.archived, true);
  assert.equal(result.status, 'archived');
  assert.deepEqual(result.forgottenTiers, ['standard']);
  assert.equal(archivedStub.countOf('deletePlan'), 1);
});

test('removing a plan the provider does not know about surfaces a 404', async () => {
  const stub = stubProvider();
  const err = await removeTierPlan(h.db, h.cfg, stub.client, 'plan_missing').catch((e: unknown) => e);
  assert.ok(err instanceof Error);
  assert.equal(httpStatusOf(err), 404);
});

test('removal does not clear tiers whose cache points elsewhere', async () => {
  // Only the tier that was actually pointing at the removed plan should be
  // forgotten; clearing the others would cause needless duplicate plans.
  const stub = stubProvider();
  const { plans } = await syncTierPlans(h.db, h.cfg, stub.client);
  const pro = plans.find((p) => p.tier === 'pro')!;

  const result = await removeTierPlan(h.db, h.cfg, stub.client, pro.planId);
  assert.deepEqual(result.forgottenTiers, ['pro']);

  const standard = await ensureTierPlan(h.db, h.cfg, stub.client, 'standard');
  assert.equal(standard.created, false, 'the untouched tier keeps its plan');
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test('the plans and cancellation routes are admin-only', async () => {
  const user = await h.seedUser('operator@example.test');
  const tokens = await h.login(user.email, user.password, 'device-1');

  for (const [method, path, body] of [
    ['GET', '/api/v1/admin/billing/plans', undefined],
    ['POST', '/api/v1/admin/billing/plans/sync', {}],
    ['PUT', '/api/v1/admin/billing/plans/price', { tier: 'standard', amountMinor: 1000 }],
    ['DELETE', '/api/v1/admin/billing/plans/price/standard', undefined],
    ['POST', '/api/v1/admin/billing/plans/delete', { planId: 'x' }],
    ['GET', '/api/v1/admin/billing/subscriptions', undefined],
    ['POST', '/api/v1/admin/billing/subscriptions/cancel', { userId: user.id }],
  ] as const) {
    const anon = await h.request(method, path, { body });
    assert.equal(anon.status, 401, `${method} ${path} must reject anonymous callers`);
    const forbidden = await h.request(method, path, { token: tokens.accessToken, body });
    assert.equal(forbidden.status, 403, `${method} ${path} must reject non-admins`);
  }
});

test('plan removal requires a plan id', async () => {
  const admin = await h.adminToken();
  for (const body of [{}, { planId: '' }, { planId: '   ' }, { planId: 42 }]) {
    const res = await h.request('POST', '/api/v1/admin/billing/plans/delete', { token: admin, body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, 'VALIDATION');
  }
});

test('cancellation requires a target', async () => {
  const admin = await h.adminToken();
  for (const body of [{}, { userId: '' }, { providerSubscriptionId: '' }, { userId: '   ' }]) {
    const res = await h.request('POST', '/api/v1/admin/billing/subscriptions/cancel', { token: admin, body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('cancellation 404s when no provider subscription is recorded', async () => {
  const admin = await h.adminToken();
  const user = await h.seedUser('nosub@example.test');
  const res = await h.request('POST', '/api/v1/admin/billing/subscriptions/cancel', { token: admin, body: { userId: user.id } });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
});

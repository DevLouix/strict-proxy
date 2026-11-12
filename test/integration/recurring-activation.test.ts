/**
 * Recurring billing activation.
 *
 * The first month is a one-off hosted checkout; this is the step that turns the
 * saved card into a monthly subscription without charging the already-paid month
 * a second time. The provider is stubbed: these tests pin what we call and what
 * we persist, not the provider's own billing behaviour.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';
import { activateRecurringSubscription } from '../../apps/controller/src/services/recurring.js';
import { PLAN_TIER_METADATA_KEY } from '../../apps/controller/src/services/plans.js';

let h: Harness;

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
  trial_days: number;
  status: string;
  metadata: Record<string, unknown>;
}

interface StubOptions {
  plans?: PlanRecord[];
  methods?: Array<{ id: string; reusable: boolean; is_default?: boolean }>;
}

/** Provider surface used by activation, with call recording. */
function stubProvider(opts: StubOptions = {}) {
  const plans: PlanRecord[] = [...(opts.plans ?? [])];
  const methods = opts.methods ?? [{ id: 'pm_card_1', reusable: true, is_default: true }];
  const created: Record<string, unknown>[] = [];
  const updated: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let seq = 0;

  const client = {
    apps: { list: async () => ({ data: [{ id: APP, merchant_id: MERCHANT }] }) },
    subscriptions: {
      listPlans: async () => ({ data: plans.map((p) => ({ ...p })) }),
      getPlan: async (id: string) => {
        const found = plans.find((p) => p.id === id);
        if (!found) throw Object.assign(new Error('Plan not found'), { status: 404, name: 'OpenPayError' });
        return { ...found };
      },
      createPlan: async (params: Record<string, unknown>) => {
        const plan: PlanRecord = {
          id: `plan_${++seq}`,
          merchant_id: String(params.merchant_id),
          name: String(params.name),
          amount: Number(params.amount),
          currency: String(params.currency),
          interval_unit: 'month',
          interval_count: 1,
          trial_days: Number(params.trial_days ?? 0),
          status: 'active',
          metadata: (params.metadata as Record<string, unknown>) ?? {},
        };
        plans.push(plan);
        return { ...plan };
      },
      updatePlan: async (id: string, patch: Record<string, unknown>) => {
        updated.push({ id, patch });
        const found = plans.find((p) => p.id === id);
        if (!found) throw Object.assign(new Error('Plan not found'), { status: 404, name: 'OpenPayError' });
        Object.assign(found, patch);
        return { ...found };
      },
      create: async (params: Record<string, unknown>) => {
        created.push(params);
        return {
          id: `sub_${created.length}`,
          customer_id: params.customer_id,
          plan_id: params.plan_id,
          status: 'trialing',
          current_period_start: new Date().toISOString(),
          current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        };
      },
    },
    customers: { paymentMethods: async () => ({ data: methods.map((m) => ({ ...m })) }) },
  };

  return { client: client as never, plans, created, updated };
}

/** A paid account whose first checkout has been settled by the webhook. */
async function paidCustomer(email = 'recurring@example.test', tier = 'standard') {
  const user = await h.seedUser(email);
  await h.setTier(user.id, tier);
  await h.query(
    `UPDATE subscriptions
        SET current_period_end = now() + interval '24 days', provider_customer_id = 'cus_recurring'
      WHERE user_id = '${user.id}'`,
  );
  return user;
}

before(async () => {
  h = await createHarness({ openpayApiKey: 'pk_test', openpayWebhookSecret: 'whsec_test' });
});

after(async () => {
  await h.stop();
});

beforeEach(async () => {
  await h.resetDb();
});

test('a settled checkout is turned into a monthly subscription for the paid tier', async () => {
  const user = await paidCustomer();
  const stub = stubProvider();

  const result = await activateRecurringSubscription(h.db, h.cfg, user.id, stub.client);
  assert.equal(result.activated, true);
  assert.equal(result.tier, 'standard');
  assert.equal(result.providerSubscriptionId, 'sub_1');

  // The plan is monthly and its trial is exactly the time left in the paid
  // period (24 days in this fixture), so the provider neither double-charges
  // the paid month nor hands out free days.
  const plan = stub.plans[0]!;
  assert.equal(plan.interval_unit, 'month');
  assert.equal(plan.interval_count, 1);
  assert.equal(plan.trial_days, 24);
  assert.equal(plan.metadata[PLAN_TIER_METADATA_KEY], 'standard');

  assert.equal(stub.created.length, 1);
  assert.equal(stub.created[0]!.plan_id, plan.id);
  assert.equal(stub.created[0]!.customer_id, 'cus_recurring');
  assert.equal(stub.created[0]!.payment_method_id, 'pm_card_1');
  assert.equal((stub.created[0]!.metadata as Record<string, unknown>).user_id, user.id);

  const [row] = await h.query<{ provider_subscription_id: string; provider: string }>(
    `SELECT provider_subscription_id, provider FROM subscriptions WHERE user_id = '${user.id}'`,
  );
  assert.equal(row.provider_subscription_id, 'sub_1');
  assert.equal(row.provider, 'openpay');
});

test('the subscription response reports auto-renew once activation succeeded', async () => {
  const user = await paidCustomer();
  const stub = stubProvider();
  await activateRecurringSubscription(h.db, h.cfg, user.id, stub.client);

  const tokens = await h.login(user.email, user.password, 'device-1');
  const res = await h.request<{ autoRenew: boolean }>('GET', '/api/v1/billing/subscription', { token: tokens.accessToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.autoRenew, true);
});

test('activation is idempotent and does not create a second subscription', async () => {
  const user = await paidCustomer();
  const stub = stubProvider();

  await activateRecurringSubscription(h.db, h.cfg, user.id, stub.client);
  const second = await activateRecurringSubscription(h.db, h.cfg, user.id, stub.client);

  assert.equal(second.activated, true);
  assert.equal(second.reason, 'already_active');
  assert.equal(stub.created.length, 1);
});

test('a plan created before monthly billing existed gets the trial before subscribing', async () => {
  const user = await paidCustomer();
  const legacy: PlanRecord = {
    id: 'plan_legacy',
    merchant_id: MERCHANT,
    name: 'StrictProxy Standard (standard)',
    amount: h.cfg.billingStandardAmountMinor,
    currency: h.cfg.billingCurrency,
    interval_unit: 'month',
    interval_count: 1,
    trial_days: 0,
    status: 'active',
    metadata: { [PLAN_TIER_METADATA_KEY]: 'standard', strict_proxy_source: 'strict-proxy' },
  };
  const stub = stubProvider({ plans: [legacy] });

  const result = await activateRecurringSubscription(h.db, h.cfg, user.id, stub.client);
  assert.equal(result.activated, true);
  assert.equal(stub.updated.length, 1);
  assert.equal(stub.updated[0]!.id, 'plan_legacy');
  assert.equal(stub.updated[0]!.patch.trial_days, 24, 'the trial is the remaining paid time, not a free month');
  assert.equal(stub.created[0]!.plan_id, 'plan_legacy');
});

test('a reusable saved card is preferred over a one-off one', async () => {
  const user = await paidCustomer();
  const stub = stubProvider({
    methods: [
      { id: 'pm_oneoff', reusable: false },
      { id: 'pm_reusable', reusable: true },
    ],
  });

  await activateRecurringSubscription(h.db, h.cfg, user.id, stub.client);
  assert.equal(stub.created[0]!.payment_method_id, 'pm_reusable');
});

test('an account with no saved card is told what is missing, and nothing is created', async () => {
  const user = await paidCustomer();
  const stub = stubProvider({ methods: [] });

  const result = await activateRecurringSubscription(h.db, h.cfg, user.id, stub.client);
  assert.equal(result.activated, false);
  assert.equal(result.reason, 'no_saved_card');
  assert.equal(stub.created.length, 0);
});

test('a free or lapsed account cannot start a subscription', async () => {
  const free = await h.seedUser('free-recurring@example.test');
  await h.setTier(free.id, 'free');
  const stub = stubProvider();

  assert.equal((await activateRecurringSubscription(h.db, h.cfg, free.id, stub.client)).reason, 'not_paid');

  const lapsed = await paidCustomer('lapsed-recurring@example.test');
  await h.query(`UPDATE subscriptions SET current_period_end = now() - interval '1 day' WHERE user_id = '${lapsed.id}'`);
  assert.equal((await activateRecurringSubscription(h.db, h.cfg, lapsed.id, stub.client)).reason, 'not_paid');
  assert.equal(stub.created.length, 0);
});

test('a customer id missing from the first payment is reported instead of guessed', async () => {
  const user = await paidCustomer('no-customer-recurring@example.test');
  await h.query(`UPDATE subscriptions SET provider_customer_id = NULL WHERE user_id = '${user.id}'`);
  const stub = stubProvider();

  const result = await activateRecurringSubscription(h.db, h.cfg, user.id, stub.client);
  assert.equal(result.activated, false);
  assert.equal(result.reason, 'no_customer');
  assert.equal(stub.created.length, 0);
});

test('the activation route requires an authenticated account', async () => {
  const res = await h.request('POST', '/api/v1/billing/recurring/activate', { body: {} });
  assert.equal(res.status, 401);
});

/**
 * Opt-in live integration test against a real OpenPay deployment.
 *
 * Skipped unless `OPENPAY_API_KEY` is set, so CI stays hermetic. Run with:
 *
 *   OPENPAY_API_KEY=pk_... \
 *   OPENPAY_BASE_URL=https://api.openpay.example.com npm run test:integration
 *
 * What it proves: the base URL is reachable, the key is accepted, and the
 * controller's real checkout path (env -> catalog -> SDK -> database ledger)
 * behaves correctly.
 *
 * What it CANNOT prove: webhook signature verification, because that needs the
 * provider to deliver a POST to a publicly reachable endpoint. That path is
 * covered deterministically by `openpay-webhooks.test.ts`.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';

const apiKey = process.env.OPENPAY_API_KEY ?? '';
const baseUrl = process.env.OPENPAY_BASE_URL ?? '';
const skip = apiKey && baseUrl ? false : 'set OPENPAY_API_KEY and OPENPAY_BASE_URL to run the live suite';

let h: Harness | undefined;

/**
 * Whether the merchant has a settlement provider configured. Without one the
 * gateway rejects every checkout, which is an operator-side prerequisite rather
 * than a defect in this integration.
 */
let providersConfigured: boolean | undefined;

before(async () => {
  h = await createHarness({
    openpayApiKey: apiKey,
    openpayWebhookSecret: process.env.OPENPAY_WEBHOOK_SECRET ?? 'live-test-secret-not-used',
    openpayBaseUrl: baseUrl,
  });

  try {
    const { createOpenPayClient } = await import('../../apps/controller/src/services/openpay.js');
    const client = createOpenPayClient(h.cfg);
    const status = (await client.status.get()) as { services?: { providers?: Record<string, unknown> } };
    const providers = status?.services?.providers;
    providersConfigured =
      providers && typeof providers === 'object' && Object.keys(providers).length > 0 ? true : undefined;
  } catch {
    providersConfigured = undefined;
  }
});

after(async () => {
  await h?.stop();
});

async function login(): Promise<string> {
  const email = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = 'live integration password';
  await h!.request('POST', '/api/v1/auth/register', { body: { email, password } });
  const res = await h!.request<{ accessToken: string }>('POST', '/api/v1/auth/login', {
    body: { email, password, deviceId: 'live-test' },
  });
  assert.equal(res.status, 200, `live login failed: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

async function currentUserId(token: string): Promise<string> {
  const res = await h!.request<{ user: { id: string } }>('GET', '/api/v1/me', { token });
  assert.equal(res.status, 200);
  return res.body.user.id;
}

test('the live gateway reports itself configured', { skip }, async () => {
  const token = await login();
  const res = await h!.request('GET', '/api/v1/billing/catalog', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.gateway, 'openpay', 'the adapter should be the live one');
  assert.ok(res.body.tiers.length > 0, 'the catalog should list purchasable tiers');
});

test('the live platform status is reachable through the SDK', { skip }, async () => {
  const { createOpenPayClient } = await import('../../apps/controller/src/services/openpay.js');
  const client = createOpenPayClient(h!.cfg);
  const status = (await client.status.get()) as { status?: string };
  assert.ok(typeof status.status === 'string' && status.status.length > 0, 'expected a status payload');
});

test('the API key is accepted by the live gateway', { skip }, async () => {
  const { createOpenPayClient } = await import('../../apps/controller/src/services/openpay.js');
  const client = createOpenPayClient(h!.cfg);
  // A read the key must be able to perform; this throws on 401/403.
  const currencies = (await client.currencies.list()) as { data?: unknown[] };
  assert.ok(Array.isArray(currencies.data));
});

test('the free tier is never purchasable against the live gateway', { skip }, async () => {
  const token = await login();
  const res = await h!.request('POST', '/api/v1/billing/checkout', { token, body: { tier: 'free' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'TIER_NOT_PURCHASABLE');
});

test('unsigned webhooks are rejected with the live secret configured', { skip }, async () => {
  const res = await h!.request('POST', '/webhooks/payments', {
    rawBody: JSON.stringify({ id: 'live-unattested', type: 'charge.success' }),
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'WEBHOOK_UNVERIFIED');
});

test(
  'a checkout opens against the live gateway and is recorded locally',
  { skip: skip || providersConfigured !== true },
  async () => {
    const token = await login();
    const userId = await currentUserId(token);

    const res = await h!.request('POST', '/api/v1/billing/checkout', { token, body: { tier: 'standard' } });
    assert.equal(res.status, 201, `expected a created checkout, got ${res.status}: ${JSON.stringify(res.body)}`);

    // Shape assertions the client depends on.
    assert.equal(res.body.tier, 'standard');
    assert.ok((res.body.checkoutUrl as string).length > 0, 'a checkout without a URL is unusable');
    assert.ok((res.body.reference as string).length > 0, 'a checkout without a reference cannot be correlated');
    assert.equal(res.body.currency, h!.cfg.billingCurrency);
    assert.equal(res.body.amountMinor, h!.cfg.billingStandardAmountMinor);
    assert.equal(new URL(res.body.checkoutUrl).protocol, 'https:', 'payment context must not leave over plain http');

    // The durable ledger row is what lets a webhook resolve the user later.
    const rows = await h!.query<any>(
      `SELECT reference, provider_reference, session_id, tier, status FROM billing_checkouts WHERE user_id = '${userId}'`,
    );
    assert.equal(rows.length, 1, 'exactly one checkout row should exist');
    assert.equal(rows[0].tier, 'standard');
    assert.equal(rows[0].status, 'open');
    assert.ok(rows[0].provider_reference, 'the provider reference must be captured for webhook matching');
  },
);

test(
  'a rejected checkout surfaces the provider reason instead of a generic 500',
  { skip: skip || providersConfigured === true },
  async () => {
    // With no settlement provider configured the gateway rejects the charge.
    // The controller must report *that*, not "internal error".
    const token = await login();
    const res = await h!.request('POST', '/api/v1/billing/checkout', { token, body: { tier: 'standard' } });

    assert.notEqual(res.status, 201, 'this test only applies when checkout creation is rejected');
    assert.ok(res.status >= 400, 'a rejection must not be a success');
    assert.notEqual(res.body.code, 'INTERNAL', 'the gateway reason must not be flattened to INTERNAL');
    assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0, 'a reason must be surfaced');
    console.log(`    [live] gateway rejection surfaced as ${res.status} ${res.body.code}: ${res.body.error}`);

    // Nothing must be recorded for a checkout the provider refused.
    const userId = await currentUserId(token);
    const rows = await h!.query<any>(`SELECT id FROM billing_checkouts WHERE user_id = '${userId}'`);
    assert.equal(rows.length, 0, 'a rejected checkout must not leave a ledger row');
  },
);
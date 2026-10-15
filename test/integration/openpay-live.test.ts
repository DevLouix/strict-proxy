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
 * Result of one real probe checkout, made during setup.
 *
 * Capability is determined empirically rather than by reading
 * `status.services.providers`: that map is empty even when a settlement
 * provider is configured and working, so inferring readiness from it would
 * wrongly skip the happy path.
 */
let probeCheckout: { created: boolean; status: number; code?: string; error?: string } | undefined;

before(async () => {
  h = await createHarness({
    openpayApiKey: apiKey,
    openpayWebhookSecret: process.env.OPENPAY_WEBHOOK_SECRET ?? 'live-test-secret-not-used',
    openpayBaseUrl: baseUrl,
  });

  const token = await login();
  const res = await h.request('POST', '/api/v1/billing/checkout', { token, body: { tier: 'standard' } });
  probeCheckout = { created: res.status === 201, status: res.status, code: res.body.code, error: res.body.error };
});

after(async () => {
  await h?.stop();
});

async function login(): Promise<string> {
  // `example.com`, not `example.test`: settlement providers validate the TLD
  // and reject synthetic domains, which would fail every checkout for a
  // reason that has nothing to do with this code.
  const email = `strictproxy-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
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
  { skip },
  async (t) => {
    // Deferred on purpose: the probe runs in `before`, which is later than the
    // point at which a static `skip` option would be evaluated.
    if (probeCheckout?.created !== true) {
      t.skip(`live gateway could not open a checkout (${probeCheckout?.status} ${probeCheckout?.code ?? ''}: ${probeCheckout?.error ?? 'unknown'})`);
      return;
    }

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
  { skip },
  async (t) => {
    // `before` already made a real checkout attempt. Only meaningful when the
    // gateway actually refused it.
    if (probeCheckout?.created === true) {
      t.skip('live gateway accepts checkouts, so there is no rejection to inspect');
      return;
    }

    // The controller must have reported the gateway's own reason, not
    // "internal error".
    const observed = probeCheckout!;
    assert.equal(observed.created, false, 'this test only applies when checkout creation is rejected');
    assert.ok(observed.status >= 400, 'a rejection must not be a success');
    assert.notEqual(observed.code, 'INTERNAL', 'the gateway reason must not be flattened to INTERNAL');
    assert.ok(typeof observed.error === 'string' && observed.error.length > 0, 'a reason must be surfaced');
    console.log(`    [live] gateway rejection surfaced as ${observed.status} ${observed.code}: ${observed.error}`);
  },
);
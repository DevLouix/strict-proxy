/**
 * The operator-facing provider diagnostic.
 *
 * "Billing is broken" has two very different causes — our key is wrong, or the
 * merchant's account cannot take money — and a failed charge looks the same
 * either way. This endpoint asks the gateway which one it is, so these tests pin
 * that the readiness data reaches the operator intact and that the route stays
 * admin-only.
 *
 * The gateway is a local stub; nothing here depends on the real provider.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHarness, type Harness } from '../helpers/harness.js';

const MERCHANT = '11111111-1111-1111-1111-111111111111';
const APP = '22222222-2222-2222-2222-222222222222';

let h: Harness;
let stub: http.Server;
let gatewayBaseUrl: string;
/** Paths the controller asked the gateway for, so the calls themselves are asserted. */
let gatewayPaths: string[];
/** When set, the stub answers as an unhealthy gateway would. */
let gatewayDown = false;

before(async () => {
  gatewayPaths = [];
  stub = http.createServer((req, res) => {
    gatewayPaths.push(req.url ?? '');
    const url = req.url ?? '';
    res.setHeader('content-type', 'application/json');

    if (gatewayDown) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'gateway unavailable' }));
      return;
    }

    if (url.startsWith('/v1/apps')) {
      res.end(JSON.stringify({ data: [{ id: APP, merchant_id: MERCHANT }], has_more: false }));
      return;
    }
    if (url.startsWith('/v1/providers/readiness')) {
      res.end(JSON.stringify({
        data: {
          merchant_id: MERCHANT,
          app_id: null,
          currency: 'NGN',
          generated_at: new Date().toISOString(),
          providers: [
            {
              provider: 'paystack',
              configured: true,
              scope: 'app',
              key_mode: 'test',
              credentials: 'valid',
              credential_checked_recently: true,
              currency_supported: true,
              available: false,
              settlement: { mode: 'account_fallback' },
              reasons: ['Credentials are valid.'],
              next_steps: ['Enable a payment channel on the provider account.'],
            },
          ],
        },
      }));
      return;
    }
    if (url.startsWith('/v1/providers/health')) {
      res.end(JSON.stringify({ data: { status: 'degraded', healthy_providers: 0, degraded_providers: 1, configured_providers: 1, total_providers: 4, providers: [], generated_at: new Date().toISOString() } }));
      return;
    }
    if (url.startsWith('/v1/providers/fees')) {
      res.end(JSON.stringify({ data: { paystack: { percentage: 0.015, cap: 2000, flatFee: 100 } } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  gatewayBaseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

  h = await createHarness({
    openpayApiKey: 'pk_test',
    openpayWebhookSecret: 'whsec_test',
    openpayBaseUrl: gatewayBaseUrl,
  });
});

after(async () => {
  await h.stop();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

beforeEach(async () => {
  await h.resetDb();
  gatewayPaths = [];
  gatewayDown = false;
});

test('provider readiness is reported with the gateway own reasons', async () => {
  const admin = await h.adminToken();
  const res = await h.request<{
    gateway: string;
    currency: string;
    merchantId: string;
    providers: Array<{ provider: string; available: boolean; credentials: string; next_steps: string[] }>;
    health: { status: string };
    fees: Record<string, unknown> | null;
  }>('GET', '/api/v1/admin/billing/providers', { token: admin });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.gateway, 'openpay');
  assert.equal(res.body.currency, 'NGN');
  assert.equal(res.body.merchantId, MERCHANT);
  assert.equal(res.body.providers.length, 1);

  const paystack = res.body.providers[0]!;
  assert.equal(paystack.provider, 'paystack');
  assert.equal(paystack.available, false, 'the gateway says it cannot charge, and that must survive');
  assert.equal(paystack.credentials, 'valid', 'a valid key with an unready account is the whole point');
  assert.deepEqual(paystack.next_steps, ['Enable a payment channel on the provider account.']);
  assert.equal(res.body.health.status, 'degraded');
  assert.ok(res.body.fees, 'fees are surfaced when the gateway provides them');

  // The diagnostic must ask about the configured currency, not guess one.
  assert.ok(gatewayPaths.some((p) => p.startsWith('/v1/providers/readiness') && p.includes('currency=NGN')), gatewayPaths.join(', '));
});

test('the diagnostic requires an administrator', async () => {
  assert.equal((await h.request('GET', '/api/v1/admin/billing/providers')).status, 401);

  const user = await h.seedUser(`not-admin-${Date.now()}@example.test`);
  const tokens = await h.login(user.email, user.password, 'device-1');
  assert.equal((await h.request('GET', '/api/v1/admin/billing/providers', { token: tokens.accessToken })).status, 403);
});

test('an unreachable gateway is reported as an error, not a crash', async () => {
  const admin = await h.adminToken();
  gatewayDown = true;

  const res = await h.request('GET', '/api/v1/admin/billing/providers', { token: admin });
  assert.ok(res.status >= 500, `expected a server error, got ${res.status}`);
  assert.equal(typeof res.body.error, 'string');
});

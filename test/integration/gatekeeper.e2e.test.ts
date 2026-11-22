/**
 * End-to-end test for the Gatekeeper SDK against the real controller.
 *
 * Boots a second Express app behind the Gatekeeper middleware and asserts the
 * admit/deny decision, plus the failure modes that matter for a paywall.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createHarness, type Harness } from '../helpers/harness.js';
import { Gatekeeper, createGatekeeperMiddleware } from '@strict-proxy/gatekeeper';

let h: Harness;
let gkBaseUrl: string;
let stopGatekeeper: () => Promise<void>;

/** Starts a Gatekeeper-protected origin and returns its base URL. */
async function startProtectedOrigin(
  options: Partial<Parameters<typeof createGatekeeperMiddleware>[0]> = {},
): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const app = express();
  app.set('trust proxy', true);
  app.use(
    createGatekeeperMiddleware({
      controllerBaseUrl: h.baseUrl,
      publicKeys: { [h.cfg.signingKeyId]: h.infra.signingPublicKeyPem },
      cacheTtlSeconds: 1,
      trustForwardedFor: true,
      fetchTimeoutMs: 2000,
      ...options,
    } as Parameters<typeof createGatekeeperMiddleware>[0]),
  );
  app.get('/protected', (req, res) => res.json({ ok: true, secret: 'fleet-only', tier: req.strictProxy?.tier ?? null }));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function visit(url: string, clientIp: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers: { 'x-forwarded-for': clientIp, ...headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Mints the short-lived token a client would present to a gated site. */
async function entitlementFor(email: string, tier: string): Promise<string> {
  const user = await h.seedUser(email);
  await h.setTier(user.id, tier);
  const tokens = await h.login(user.email, user.password, `device-${email}`);
  const res = await h.request<{ token: string }>('GET', '/api/v1/entitlement', { token: tokens.accessToken });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.token.startsWith('sp1.'));
  return res.body.token;
}

before(async () => {
  h = await createHarness();
  const origin = await startProtectedOrigin();
  gkBaseUrl = origin.baseUrl;
  stopGatekeeper = origin.stop;
});

after(async () => {
  await stopGatekeeper();
  await h.stop();
});

beforeEach(async () => {
  await h.resetDb();
  // The Gatekeeper caches for 1s; give the window a chance to lapse between
  // tests so each case observes a freshly fetched list.
  await new Promise((r) => setTimeout(r, 1100));
});

test('a fleet IP is admitted and a stranger is denied', async () => {
  await h.seedNode({ status: 'online', publicIp: '203.0.113.10' });

  const allowed = await visit(`${gkBaseUrl}/protected`, '203.0.113.10');
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.secret, 'fleet-only');

  const denied = await visit(`${gkBaseUrl}/protected`, '198.51.100.99');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'GATEKEEPER_DENIED');
});

test('the deny payload tells the user how to get access', async () => {
  const denied = await visit(`${gkBaseUrl}/protected`, '198.51.100.99');
  assert.equal(denied.body.error, typeof denied.body.error === 'string' ? denied.body.error : '');
  assert.ok(denied.body.hint, 'a non-fleet client should be told to connect the VPN');
});

test('an offline node is not admitted even from its IP', async () => {
  await h.seedNode({ status: 'offline', publicIp: '203.0.113.11' });
  await h.seedNode({ status: 'online', publicIp: '203.0.113.12' });

  assert.equal((await visit(`${gkBaseUrl}/protected`, '203.0.113.11')).status, 403);
  assert.equal((await visit(`${gkBaseUrl}/protected`, '203.0.113.12')).status, 200);
});

test('every reachable node in the fleet is admitted', async () => {
  await h.seedNode({ status: 'online', publicIp: '203.0.113.20' });
  await h.seedNode({ status: 'degraded', publicIp: '203.0.113.21' });
  await h.seedNode({ status: 'draining', publicIp: '203.0.113.22' });

  assert.equal((await visit(`${gkBaseUrl}/protected`, '203.0.113.20')).status, 200);
  assert.equal((await visit(`${gkBaseUrl}/protected`, '203.0.113.21')).status, 200);
  assert.equal((await visit(`${gkBaseUrl}/protected`, '203.0.113.22')).status, 403, 'draining nodes are not client-visible');
});

test('a list signed by an unknown key is refused', async () => {
  await h.seedNode({ status: 'online', publicIp: '203.0.113.30' });

  const origin = await startProtectedOrigin({ publicKeys: { 'a-different-key': h.infra.signingPublicKeyPem } });
  try {
    const res = await visit(`${origin.baseUrl}/protected`, '203.0.113.30');
    assert.equal(res.status, 403, 'an unknown key id must fail closed');
  } finally {
    await origin.stop();
  }
});

test('a list signed by the wrong key is refused', async () => {
  await h.seedNode({ status: 'online', publicIp: '203.0.113.31' });

  const { generateEd25519Keypair } = await import('@strict-proxy/types');
  const attacker = generateEd25519Keypair();
  const origin = await startProtectedOrigin({ publicKeys: { [h.cfg.signingKeyId]: attacker.publicKeyPem } });
  try {
    const res = await visit(`${origin.baseUrl}/protected`, '203.0.113.31');
    assert.equal(res.status, 403, 'a forged signature must fail closed');
  } finally {
    await origin.stop();
  }
});

test('failureMode closed denies everything when the controller is unreachable', async () => {
  const origin = await startProtectedOrigin({
    controllerBaseUrl: 'http://127.0.0.1:1',
    failureMode: 'closed',
  });
  try {
    const res = await visit(`${origin.baseUrl}/protected`, '203.0.113.10');
    assert.equal(res.status, 403, 'controller down => deny');
  } finally {
    await origin.stop();
  }
});

test('failureMode open allows traffic when the controller is unreachable', async () => {
  const origin = await startProtectedOrigin({
    controllerBaseUrl: 'http://127.0.0.1:1',
    failureMode: 'open',
  });
  try {
    const res = await visit(`${origin.baseUrl}/protected`, '203.0.113.10');
    assert.equal(res.status, 200);
  } finally {
    await origin.stop();
  }
});

test('a custom deny response overrides the default payload', async () => {
  const origin = await startProtectedOrigin({ denyResponse: { status: 402, body: { error: 'paywall', code: 'SUBSCRIBE' } } });
  try {
    const res = await visit(`${origin.baseUrl}/protected`, '198.51.100.5');
    assert.equal(res.status, 402);
    assert.equal(res.body.code, 'SUBSCRIBE');
  } finally {
    await origin.stop();
  }
});

test('a redirect deny response sends the client to the given URL', async () => {
  const origin = await startProtectedOrigin({ denyResponse: { redirectUrl: 'https://example.com/subscribe' } });
  try {
    const res = await fetch(`${origin.baseUrl}/protected`, { headers: { 'x-forwarded-for': '198.51.100.6' }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://example.com/subscribe');
  } finally {
    await origin.stop();
  }
});

test('without trustForwardedFor a spoofed header cannot grant access', async () => {
  await h.seedNode({ status: 'online', publicIp: '203.0.113.40' });

  const origin = await startProtectedOrigin({ trustForwardedFor: false });
  try {
    // The socket is 127.0.0.1, which is not a fleet IP; the spoofed header
    // must be ignored rather than believed.
    const res = await visit(`${origin.baseUrl}/protected`, '203.0.113.40');
    assert.equal(res.status, 403);
  } finally {
    await origin.stop();
  }
});

test('the signed list is cached and refreshed within the TTL', async () => {
  await h.seedNode({ status: 'online', publicIp: '203.0.113.50' });
  assert.equal((await visit(`${gkBaseUrl}/protected`, '203.0.113.50')).status, 200);

  // Adding a node must not be visible until the cache lapses.
  await h.seedNode({ status: 'online', publicIp: '203.0.113.51' });
  assert.equal((await visit(`${gkBaseUrl}/protected`, '203.0.113.51')).status, 403, 'stale cache must not admit a new node');

  await new Promise((r) => setTimeout(r, 1200));
  assert.equal((await visit(`${gkBaseUrl}/protected`, '203.0.113.51')).status, 200, 'cache must refresh after the TTL');
});

// ---------------------------------------------------------------------------
// Plan gating
// ---------------------------------------------------------------------------

test('a pro-only site rejects standard and admits pro', async () => {
  await h.seedNode({ status: 'online', publicIp: '203.0.113.60' });
  const standard = await entitlementFor('standard-gate@example.test', 'standard');
  const pro = await entitlementFor('pro-gate@example.test', 'pro');

  const origin = await startProtectedOrigin({ requiredTier: 'pro' });
  try {
    const missing = await visit(`${origin.baseUrl}/protected`, '203.0.113.60');
    assert.equal(missing.status, 401);
    assert.equal(missing.body.code, 'GATEKEEPER_ENTITLEMENT_REQUIRED');

    const denied = await visit(`${origin.baseUrl}/protected`, '203.0.113.60', {
      'x-strict-proxy-entitlement': standard,
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'GATEKEEPER_TIER_INSUFFICIENT');
    assert.equal(denied.body.actualTier, 'standard');
    assert.equal(denied.body.requiredTier, 'pro');

    const allowed = await visit(`${origin.baseUrl}/protected`, '203.0.113.60', {
      'x-strict-proxy-entitlement': pro,
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.tier, 'pro', 'the verified plan must be available to the site');
  } finally {
    await origin.stop();
  }
});

test('a standard site admits standard and pro, but not free', async () => {
  await h.seedNode({ status: 'online', publicIp: '203.0.113.61' });
  const free = await entitlementFor('free-gate@example.test', 'free');
  const standard = await entitlementFor('standard-gate-2@example.test', 'standard');
  const pro = await entitlementFor('pro-gate-2@example.test', 'pro');

  const origin = await startProtectedOrigin({ requiredTier: 'standard' });
  try {
    const denied = await visit(`${origin.baseUrl}/protected`, '203.0.113.61', {
      'x-strict-proxy-entitlement': free,
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'GATEKEEPER_TIER_INSUFFICIENT');
    assert.equal(denied.body.actualTier, 'free');

    assert.equal((await visit(`${origin.baseUrl}/protected`, '203.0.113.61', { 'x-strict-proxy-entitlement': standard })).status, 200);
    assert.equal((await visit(`${origin.baseUrl}/protected`, '203.0.113.61', { 'x-strict-proxy-entitlement': pro })).status, 200);
  } finally {
    await origin.stop();
  }
});

test('failureMode open skips only the fleet check, never plan gating', async () => {
  const token = await entitlementFor('open-mode@example.test', 'standard');
  const origin = await startProtectedOrigin({
    controllerBaseUrl: 'http://127.0.0.1:1',
    failureMode: 'open',
    requiredTier: 'standard',
  });
  try {
    const missing = await visit(`${origin.baseUrl}/protected`, '203.0.113.70');
    assert.equal(missing.status, 401, 'an unreachable controller must not bypass the plan check');
    assert.equal(missing.body.code, 'GATEKEEPER_ENTITLEMENT_REQUIRED');

    const allowed = await visit(`${origin.baseUrl}/protected`, '203.0.113.70', {
      'x-strict-proxy-entitlement': token,
    });
    assert.equal(allowed.status, 200);
  } finally {
    await origin.stop();
  }
});

test('a forged entitlement token is rejected even from a fleet IP', async () => {
  await h.seedNode({ status: 'online', publicIp: '203.0.113.62' });
  const token = await entitlementFor('forged-gate@example.test', 'pro');
  const forged = `${token.slice(0, -2)}${token.endsWith('A') ? 'B' : 'A'}`;

  const origin = await startProtectedOrigin({ requiredTier: 'standard' });
  try {
    const res = await visit(`${origin.baseUrl}/protected`, '203.0.113.62', { 'x-strict-proxy-entitlement': forged });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'GATEKEEPER_ENTITLEMENT_INVALID');
  } finally {
    await origin.stop();
  }
});

test('Key Factory: admin issues sp_gk_ site key, SDK bootstraps & enforces tier, rotate/revoke cuts off old secret', async () => {
  await h.seedNode({ status: 'online', publicIp: '203.0.113.77' });
  const adminToken = await h.adminToken();

  // 1. Admin creates a site key via the Key Factory
  const created = await h.request<{ key: { id: string; keyPrefix: string; status: string }; secret: string }>(
    'POST',
    '/api/v1/admin/gatekeeper/keys',
    {
      token: adminToken,
      body: { name: 'Partner Portal', note: 'https://partner.example.com' },
    },
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(created.body.secret.startsWith('sp_gk_'));
  const keyId = created.body.key.id;
  const firstSecret = created.body.secret;

  // 2. SDK initializes with ONLY controllerUrl + apiKey (zero PEMs!)
  const gk = Gatekeeper.init({
    controllerUrl: h.baseUrl,
    apiKey: firstSecret,
    requiredTier: 'standard',
    trustForwardedFor: true,
    trustedProxyHops: 1,
    cacheTtlSeconds: 1,
    logger: false,
  });

  const standardToken = await entitlementFor('keyfactory@example.test', 'standard');
  const allowed = await gk.authorize({
    ip: '127.0.0.1',
    headers: {
      'x-forwarded-for': '203.0.113.77',
      'x-strict-proxy-entitlement': standardToken,
    },
  });
  assert.equal(allowed.allowed, true);
  if (allowed.allowed) {
    assert.equal(allowed.user?.tier, 'standard');
  }
  assert.equal(gk.status().authMode, 'api-key');

  // Verify usage telemetry was stamped in admin listing
  const listed = await h.request<{ keys: Array<{ id: string; lastUsedAt: string | null }> }>(
    'GET',
    '/api/v1/admin/gatekeeper/keys',
    { token: adminToken },
  );
  assert.equal(listed.status, 200);
  const row = listed.body.keys.find((k) => k.id === keyId);
  assert.ok(row?.lastUsedAt, 'lastUsedAt should be recorded after bootstrap');

  // 3. Rotate key -> old secret fails 401, new secret succeeds
  const rotated = await h.request<{ key: { id: string }; secret: string }>(
    'POST',
    `/api/v1/admin/gatekeeper/keys/${keyId}/rotate`,
    { token: adminToken, body: {} },
  );
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.secret, firstSecret);

  await assert.rejects(() => gk.refresh(), /401|rejected/);

  const gkRotated = Gatekeeper.init({
    controllerUrl: h.baseUrl,
    apiKey: rotated.body.secret,
    logger: false,
  });
  assert.deepEqual(await gkRotated.refresh(), ['203.0.113.77']);

  // 4. Revoke key -> fails closed immediately on refresh
  const revoked = await h.request<{ key: { status: string } }>(
    'POST',
    `/api/v1/admin/gatekeeper/keys/${keyId}/revoke`,
    { token: adminToken, body: {} },
  );
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.key.status, 'revoked');
  await assert.rejects(() => gkRotated.refresh(), /401|rejected/);
});

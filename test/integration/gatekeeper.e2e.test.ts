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
import { createGatekeeperMiddleware } from '@strict-proxy/gatekeeper';

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
  app.get('/protected', (_req, res) => res.json({ ok: true, secret: 'fleet-only' }));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function visit(url: string, clientIp: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers: { 'x-forwarded-for': clientIp } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
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
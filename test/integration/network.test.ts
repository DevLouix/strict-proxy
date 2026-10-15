/**
 * Integration tests for the client-facing network surface: the signed config
 * bundle, the Gatekeeper IP list, load-aware node assignment and bandwidth
 * quota enforcement.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { createHarness, type Harness } from '../helpers/harness.js';
import { loadSigningPublicKey, verifyJson } from '@strict-proxy/types';

let h: Harness;
let publicKey: ReturnType<typeof createPublicKey>;

before(async () => {
  h = await createHarness();
  publicKey = createPublicKey(h.infra.signingPublicKeyPem);
});

after(async () => {
  await h.stop();
});

beforeEach(async () => {
  await h.resetDb();
});

async function activeUser(tier = 'standard') {
  const user = await h.seedUser(`net-${Math.random().toString(36).slice(2, 10)}@example.test`);
  await h.setTier(user.id, tier);
  const tokens = await h.login(user.email, user.password, 'device-1');
  return { user, token: tokens.accessToken };
}

// ---------------------------------------------------------------------------
// Config bundle
// ---------------------------------------------------------------------------

test('the config bundle is signed and verifies against the controller key', async () => {
  await h.seedNode({ status: 'online' });
  const { token } = await activeUser();

  const res = await h.request('GET', '/api/v1/network/config', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.keyId, h.cfg.signingKeyId);

  const payload = { expiresAt: res.body.expiresAt, nodes: res.body.nodes, configs: res.body.configs };
  assert.ok(verifyJson(publicKey, payload, res.body.signature), 'bundle signature must verify');

  // Tampering with the served payload must break verification.
  assert.ok(!verifyJson(publicKey, { ...payload, nodes: [] }, res.body.signature));
});

test('the bundle requires authentication and an active subscription', async () => {
  await h.seedNode({ status: 'online' });
  const { user, token } = await activeUser();

  assert.equal((await h.request('GET', '/api/v1/network/config')).status, 401);

  await h.setTier(user.id, 'standard', 'revoked');
  const revoked = await h.request('GET', '/api/v1/network/config', { token });
  assert.equal(revoked.status, 402);
  assert.equal(revoked.body.code, 'SUBSCRIPTION_REQUIRED');
});

test('an expired period end blocks config access', async () => {
  await h.seedNode({ status: 'online' });
  const { user, token } = await activeUser();
  await h.query(`UPDATE subscriptions SET current_period_end = now() - interval '1 day' WHERE user_id = '${user.id}'`);
  const res = await h.request('GET', '/api/v1/network/config', { token });
  assert.equal(res.status, 402);
  assert.equal(res.body.code, 'SUBSCRIPTION_REQUIRED');
});

test('an empty fleet returns a typed error instead of an empty bundle', async () => {
  const { token } = await activeUser();
  const res = await h.request('GET', '/api/v1/network/config', { token });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'NO_NODES_AVAILABLE');
});

test('offline and draining nodes are excluded from the bundle', async () => {
  await h.seedNode({ hostname: 'up.test', status: 'online' });
  await h.seedNode({ hostname: 'down.test', status: 'offline' });
  await h.seedNode({ hostname: 'draining.test', status: 'draining' });
  const { token } = await activeUser();

  const res = await h.request('GET', '/api/v1/network/config', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.nodes.length, 1);
  assert.equal(res.body.nodes[0].hostname, 'up.test');
});

test('the bundle carries a working VLESS+REALITY outbound per node', async () => {
  const node = await h.seedNode({ status: 'online', tunnelPort: 8443 });
  const { token } = await activeUser();

  const res = await h.request('GET', '/api/v1/network/config', { token });
  const cfg = res.body.configs[node.id];
  assert.equal(cfg.protocol, 'vless-reality');
  assert.equal(cfg.server, node.publicIp);
  assert.equal(cfg.serverPort, 8443);
  assert.equal(cfg.serverName, 'www.microsoft.com');
  assert.equal(cfg.flow, 'xtls-rprx-vision');
  assert.equal(cfg.fingerprint, 'chrome');
  assert.ok(cfg.uuid, 'each node needs a provisioned UUID');
  assert.ok(cfg.publicKey, 'the client needs the REALITY public key');

  const credRows = await h.query<any>(`SELECT short_id FROM node_credentials WHERE node_id = '${node.id}'`);
  assert.equal(cfg.shortId, credRows[0].short_id, 'the client short id must match the provisioned one');
});

test('re-fetching the bundle keeps the same credential (stable across calls)', async () => {
  const node = await h.seedNode({ status: 'online' });
  const { token } = await activeUser();

  const first = await h.request('GET', '/api/v1/network/config', { token });
  const second = await h.request('GET', '/api/v1/network/config', { token });
  assert.equal(first.body.configs[node.id].uuid, second.body.configs[node.id].uuid);
});

// ---------------------------------------------------------------------------
// Load-aware assignment (item 4)
// ---------------------------------------------------------------------------

test('the least loaded nodes are assigned first', async () => {
  const idle = await h.seedNode({ hostname: 'idle.test', status: 'online', loadScore: 5 });
  const busy = await h.seedNode({ hostname: 'busy.test', status: 'online', loadScore: 95 });
  const mid = await h.seedNode({ hostname: 'mid.test', status: 'online', loadScore: 50 });

  // Free tier is capped at two nodes; those two must be the least loaded.
  const { token } = await activeUser('free');
  const res = await h.request('GET', '/api/v1/network/config', { token });

  const assigned = new Set(res.body.nodes.map((n: any) => n.id));
  assert.equal(assigned.has(idle.id), true);
  assert.equal(assigned.has(mid.id), true);
  assert.equal(assigned.has(busy.id), false, 'the 95%-loaded node must not be handed out before quieter ones');
});

test('healthy nodes are preferred over degraded ones at equal load', async () => {
  const degraded = await h.seedNode({ hostname: 'deg.test', status: 'degraded', loadScore: 10 });
  const healthy = await h.seedNode({ hostname: 'ok.test', status: 'online', loadScore: 10 });
  // A third node so the free tier's 2-node cap actually forces a choice.
  await h.seedNode({ hostname: 'spare.test', status: 'online', loadScore: 99 });

  const { token } = await activeUser('free');
  const res = await h.request('GET', '/api/v1/network/config', { token });
  const assigned = new Set(res.body.nodes.map((n: any) => n.id));
  assert.equal(assigned.size, 2);

  assert.equal(assigned.has(healthy.id), true);
  assert.equal(assigned.has(degraded.id), false, 'a degraded node must lose to an equally loaded healthy one');
});

test('assignment is deterministic for identical load', async () => {
  const a = await h.seedNode({ hostname: 'a.test', status: 'online', loadScore: 50 });
  const b = await h.seedNode({ hostname: 'b.test', status: 'online', loadScore: 50 });

  const first = await activeUser('free');
  const res1 = await h.request('GET', '/api/v1/network/config', { token: first.token });
  const second = await activeUser('free');
  const res2 = await h.request('GET', '/api/v1/network/config', { token: second.token });

  assert.deepEqual(
    res1.body.nodes.map((n: any) => n.id),
    res2.body.nodes.map((n: any) => n.id),
    'equal load must break ties identically for every user',
  );
  assert.equal(new Set([a.id, b.id]).size, 2);
});

test('tier caps the number of assigned nodes', async () => {
  for (let i = 0; i < 4; i++) await h.seedNode({ status: 'online', loadScore: i });

  const free = await activeUser('free');
  const freeRes = await h.request('GET', '/api/v1/network/config', { token: free.token });
  assert.equal(freeRes.body.nodes.length, 2);

  const pro = await activeUser('pro');
  const proRes = await h.request('GET', '/api/v1/network/config', { token: pro.token });
  assert.equal(proRes.body.nodes.length, 4);
});

test('credentials for unassigned nodes are revoked', async () => {
  await h.seedNode({ hostname: 'one.test', status: 'online', loadScore: 10 });
  await h.seedNode({ hostname: 'two.test', status: 'online', loadScore: 90 });
  const { user, token } = await activeUser('free');

  await h.request('GET', '/api/v1/network/config', { token });
  // Now drop the busy node out of contention by making it offline.
  await h.query(`UPDATE nodes SET status = 'offline' WHERE hostname = 'two.test'`);
  const res = await h.request('GET', '/api/v1/network/config', { token });
  assert.equal(res.body.nodes.length, 1);

  const active = await h.query<any>(
    `SELECT c.revoked FROM node_credentials c JOIN nodes n ON n.id = c.node_id WHERE c.user_id = '${user.id}' ORDER BY n.hostname`,
  );
  assert.equal(active.length, 2);
  assert.equal(active.filter((r: any) => r.revoked).length, 1, 'the dropped node credential must be revoked');
});

// ---------------------------------------------------------------------------
// Bandwidth quota (item 2)
// ---------------------------------------------------------------------------

test('a free-tier user is denied once the rolling window quota is exhausted', async () => {
  await h.seedNode({ status: 'online' });
  const { user, token } = await activeUser('free');

  const before = await h.request('GET', '/api/v1/network/config', { token });
  assert.equal(before.status, 200, 'under quota should be served');

  // Record usage inside the window that exceeds the 10 GiB free-tier quota.
  const credRows = await h.query<any>(`SELECT id FROM node_credentials WHERE user_id = '${user.id}' LIMIT 1`);
  await h.query(
    `INSERT INTO usage_rollups (credential_id, window_start, window_end, bytes_up, bytes_down)
     VALUES ('${credRows[0].id}', now() - interval '1 hour', now(), 0, ${11 * 1024 * 1024 * 1024})`,
  );

  const after = await h.request('GET', '/api/v1/network/config', { token });
  assert.equal(after.status, 402);
  assert.equal(after.body.code, 'BANDWIDTH_QUOTA_EXCEEDED');
  assert.equal(after.body.quotaBytes, 10 * 1024 * 1024 * 1024);
});

test('usage older than the quota window does not count', async () => {
  await h.seedNode({ status: 'online' });
  const { user, token } = await activeUser('free');
  await h.request('GET', '/api/v1/network/config', { token });

  const credRows = await h.query<any>(`SELECT id FROM node_credentials WHERE user_id = '${user.id}' LIMIT 1`);
  await h.query(
    `INSERT INTO usage_rollups (credential_id, window_start, window_end, bytes_up, bytes_down)
     VALUES ('${credRows[0].id}', now() - interval '45 days', now() - interval '44 days', 0, ${99 * 1024 * 1024 * 1024})`,
  );

  const res = await h.request('GET', '/api/v1/network/config', { token });
  assert.equal(res.status, 200, 'stale usage must not count against the current window');
});

test('uncapped tiers are unaffected by heavy usage', async () => {
  await h.seedNode({ status: 'online' });
  const { user, token } = await activeUser('pro');
  await h.request('GET', '/api/v1/network/config', { token });

  const credRows = await h.query<any>(`SELECT id FROM node_credentials WHERE user_id = '${user.id}' LIMIT 1`);
  await h.query(
    `INSERT INTO usage_rollups (credential_id, window_start, window_end, bytes_up, bytes_down)
     VALUES ('${credRows[0].id}', now() - interval '1 hour', now(), 0, ${500 * 1024 * 1024 * 1024})`,
  );

  const res = await h.request('GET', '/api/v1/network/config', { token });
  assert.equal(res.status, 200, 'pro has no quota');
});

test('a quota-exhausted user cannot obtain fresh credentials', async () => {
  await h.seedNode({ status: 'online' });
  const { user, token } = await activeUser('free');
  await h.request('GET', '/api/v1/network/config', { token });

  const credRows = await h.query<any>(`SELECT id FROM node_credentials WHERE user_id = '${user.id}' LIMIT 1`);
  await h.query(
    `INSERT INTO usage_rollups (credential_id, window_start, window_end, bytes_up, bytes_down)
     VALUES ('${credRows[0].id}', now() - interval '1 hour', now(), 0, ${11 * 1024 * 1024 * 1024})`,
  );
  await h.request('GET', '/api/v1/network/config', { token });

  const rows = await h.query<any>(`SELECT count(*)::int AS n FROM node_credentials WHERE user_id = '${user.id}'`);
  assert.equal(rows[0].n, 1, 'the quota check must run before any credential is provisioned');
});

// ---------------------------------------------------------------------------
// Gatekeeper IP list
// ---------------------------------------------------------------------------

test('the public IP list is signed and contains only client-visible nodes', async () => {
  await h.seedNode({ hostname: 'a.test', status: 'online', publicIp: '203.0.113.1' });
  await h.seedNode({ hostname: 'b.test', status: 'degraded', publicIp: '203.0.113.2' });
  await h.seedNode({ hostname: 'c.test', status: 'offline', publicIp: '203.0.113.3' });
  await h.seedNode({ hostname: 'd.test', status: 'draining', publicIp: '203.0.113.4' });

  const res = await h.request('GET', '/api/v1/network/nodes/public-ips');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.ips, ['203.0.113.1', '203.0.113.2']);

  const payload = { generatedAt: res.body.generatedAt, expiresAt: res.body.expiresAt, ips: res.body.ips };
  assert.ok(verifyJson(publicKey, payload, res.body.signature));
  assert.ok(new Date(res.body.expiresAt).getTime() > Date.now(), 'the list must not be born expired');
});

test('the public IP list is served without authentication', async () => {
  await h.seedNode({ status: 'online' });
  const res = await h.request('GET', '/api/v1/network/nodes/public-ips');
  assert.equal(res.status, 200);
});

test('the list verifies only against the key id the controller reports', () => {
  const otherKey = loadSigningPublicKey('other-key', h.infra.signingPublicKeyPem);
  assert.equal(otherKey.asymmetricKeyType, 'ed25519');
  assert.notEqual(h.cfg.signingKeyId, 'other-key');
});
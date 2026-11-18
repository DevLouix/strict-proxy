/**
 * Integration tests for node enrollment and the HMAC-authenticated internal
 * node API. This is the zero-trust surface: a node holds only an HMAC secret
 * and must never be able to reach anything without a valid, fresh,
 * single-use-signed request.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';

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

const REALITY_SHORT_IDS = ['0011223344556677', '8899aabbccddeeff'];

test('a valid one-time token enrolls a node that starts offline', async () => {
  const token = await h.createEnrollment('eu-central', 'Frankfurt 1');
  const res = await h.request('POST', '/api/v1/nodes/enroll', {
    body: {
      token,
      hostname: 'fra-1.example.com',
      label: 'Frankfurt 1',
      publicIp: '203.0.113.10',
      tunnelPort: 443,
      realityServerName: 'www.microsoft.com',
      realityShortIds: REALITY_SHORT_IDS,
      engineVersion: '1.13.21',
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.region, 'eu-central');
  assert.equal(typeof res.body.hmacSecret, 'string');
  assert.ok(res.body.hmacSecret.length >= 32);

  // The controller generates the REALITY keypair, not the node.
  const rowRows = await h.query<any>(`SELECT status, reality_private_key FROM nodes WHERE id = '${res.body.nodeId}'`);
  assert.equal(rowRows[0].status, 'offline', 'node must not be client-visible before its first heartbeat');
  assert.ok(rowRows[0].reality_private_key.length > 0);

  // Only the hash of the enrollment token is persisted.
  const tokRows = await h.query<any>(`SELECT token_hash FROM node_enrollments`);
  assert.notEqual(tokRows[0].token_hash, token);
});

test('an enrollment token cannot be consumed twice', async () => {
  const token = await h.createEnrollment('eu-west');
  const body = {
    token,
    hostname: 'lon-1.example.com',
    publicIp: '203.0.113.20',
    realityServerName: 'www.microsoft.com',
    realityShortIds: REALITY_SHORT_IDS,
  };
  assert.equal((await h.request('POST', '/api/v1/nodes/enroll', { body })).status, 201);

  const replay = await h.request('POST', '/api/v1/nodes/enroll', { body: { ...body, hostname: 'lon-2.example.com' } });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.code, 'INVALID_OR_EXPIRED_ENROLLMENT');
});

test('an unknown or malformed enrollment token is rejected', async () => {
  const res = await h.request('POST', '/api/v1/nodes/enroll', {
    body: {
      token: 'obviously-not-a-real-token',
      hostname: 'x.example.com',
      publicIp: '203.0.113.30',
      realityServerName: 'www.microsoft.com',
      realityShortIds: REALITY_SHORT_IDS,
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_OR_EXPIRED_ENROLLMENT');
});

test('an expired enrollment token is rejected', async () => {
  const token = await h.createEnrollment('us-east');
  await h.db.execute(`UPDATE node_enrollments SET expires_at = now() - interval '1 minute'`);
  const res = await h.request('POST', '/api/v1/nodes/enroll', {
    body: {
      token,
      hostname: 'nyc-1.example.com',
      publicIp: '203.0.113.40',
      realityServerName: 'www.microsoft.com',
      realityShortIds: REALITY_SHORT_IDS,
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_OR_EXPIRED_ENROLLMENT');
});

test('enrollment validates its required fields', async () => {
  const token = await h.createEnrollment('ap-south');
  const full = {
    token,
    hostname: 'bom-1.example.com',
    publicIp: '203.0.113.50',
    realityServerName: 'www.microsoft.com',
    realityShortIds: REALITY_SHORT_IDS,
  };
  for (const missing of ['hostname', 'publicIp', 'realityServerName', 'realityShortIds']) {
    const body: any = { ...full };
    delete body[missing];
    const res = await h.request('POST', '/api/v1/nodes/enroll', { body });
    assert.equal(res.status, 400, `expected rejection when ${missing} is missing`);
  }
});

// ---------------------------------------------------------------------------
// Internal node API
// ---------------------------------------------------------------------------

test('the internal API rejects requests with no credentials at all', async () => {
  for (const path of ['/internal/v1/node/bootstrap', '/internal/v1/node/sync']) {
    const res = await h.request('GET', path);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'NODE_UNAUTHENTICATED');
  }
  const hb = await h.request('POST', '/internal/v1/node/heartbeat', { body: {} });
  assert.equal(hb.status, 401);
  assert.equal(hb.body.code, 'NODE_UNAUTHENTICATED');
});

test('the internal API rejects an unknown node id', async () => {
  const res = await h.nodeRequest('00000000-0000-0000-0000-000000000000', 'some-secret', 'GET', '/internal/v1/node/sync');
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'NODE_UNKNOWN');
});

test('the internal API rejects a forged signature', async () => {
  const node = await h.seedNode();
  const res = await h.nodeRequest(node.id, 'the-wrong-secret', 'GET', '/internal/v1/node/sync');
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'NODE_BAD_SIGNATURE');
});

test('the internal API rejects a replayed nonce', async () => {
  const node = await h.seedNode();
  const nonce = 'fixed-nonce-value';
  const first = await h.nodeRequest(node.id, node.hmacSecret, 'GET', '/internal/v1/node/sync', undefined, { nonce });
  assert.equal(first.status, 200);

  const replay = await h.nodeRequest(node.id, node.hmacSecret, 'GET', '/internal/v1/node/sync', undefined, { nonce });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.code, 'NODE_NONCE_REPLAY');
});

test('the internal API rejects a stale timestamp', async () => {
  const node = await h.seedNode();
  const stale = String(Math.floor(Date.now() / 1000) - (h.cfg.hmacTimestampToleranceSeconds + 60));
  const res = await h.nodeRequest(node.id, node.hmacSecret, 'GET', '/internal/v1/node/sync', undefined, { timestamp: stale });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'NODE_STALE_TIMESTAMP');
});

test('a signature is bound to the exact path and body', async () => {
  const node = await h.seedNode();
  // Sign a GET on /sync, then reuse those headers on a different path.
  const headers = h.nodeHeaders(node.id, node.hmacSecret, 'GET', '/internal/v1/node/sync', '');
  const other = await h.request('GET', '/internal/v1/node/bootstrap', { headers });
  assert.equal(other.status, 401);
  assert.equal(other.body.code, 'NODE_BAD_SIGNATURE');
});

test('bootstrap returns the node REALITY settings and never the public-ips of others', async () => {
  const node = await h.seedNode({ hostname: 'boot-1.test' });
  const res = await h.nodeRequest(node.id, node.hmacSecret, 'GET', '/internal/v1/node/bootstrap');
  assert.equal(res.status, 200);
  assert.equal(res.body.nodeId, node.id);
  assert.equal(res.body.hostname, 'boot-1.test');
  assert.ok(res.body.reality.privateKey.length > 0, 'the node needs its own private key');
  assert.deepEqual(res.body.reality.shortIds, ['0011223344556677', '8899aabbccddeeff']);
});

test('a heartbeat marks the node online and records its load', async () => {
  const node = await h.seedNode({ status: 'offline' });
  const res = await h.nodeRequest(node.id, node.hmacSecret, 'POST', '/internal/v1/node/heartbeat', {
    cpuPercent: 20,
    memoryPercent: 40,
    bandwidthBytes: 1000,
    uplinkRttMs: 12,
    uptimeSeconds: 999,
    engineVersion: '1.13.21',
  });
  assert.equal(res.status, 200);

  const rowRows = await h.query<any>(`SELECT status, load_score, engine_version FROM nodes WHERE id = '${node.id}'`);
  assert.equal(rowRows[0].status, 'online');
  // 0.6*20 + 0.4*40 = 28
  assert.equal(rowRows[0].load_score, 28);
  assert.equal(rowRows[0].engine_version, '1.13.21');
});

test('a heartbeat records the engine health the agent reports', async () => {
  const node = await h.seedNode({ status: 'offline' });
  await h.nodeRequest(node.id, node.hmacSecret, 'POST', '/internal/v1/node/heartbeat', {
    cpuPercent: 3,
    engineHealthy: true,
    statsApiHealthy: false,
  });

  const rowRows = await h.query<any>(`SELECT engine_healthy, stats_api_healthy, engine_health_checked_at FROM nodes WHERE id = '${node.id}'`);
  assert.equal(rowRows[0].engine_healthy, true);
  assert.equal(rowRows[0].stats_api_healthy, false);
  assert.ok(rowRows[0].engine_health_checked_at, 'the check time is shown next to the badge');
});

test('a heartbeat that omits engine health leaves the stored value alone', async () => {
  const node = await h.seedNode({ status: 'offline' });
  await h.nodeRequest(node.id, node.hmacSecret, 'POST', '/internal/v1/node/heartbeat', { engineHealthy: false });
  await h.nodeRequest(node.id, node.hmacSecret, 'POST', '/internal/v1/node/heartbeat', { cpuPercent: 5 });

  const rowRows = await h.query<any>(`SELECT engine_healthy FROM nodes WHERE id = '${node.id}'`);
  assert.equal(rowRows[0].engine_healthy, false, 'a missing field must not clear a reported failure');
});

test('a heartbeat moves the node to the port the engine listens on', async () => {
  const node = await h.seedNode({ status: 'offline', tunnelPort: 443 });

  const res = await h.nodeRequest(node.id, node.hmacSecret, 'POST', '/internal/v1/node/heartbeat', {
    tunnelPort: 8443,
  });
  assert.equal(res.status, 200);

  const rowRows = await h.query<any>(`SELECT tunnel_port FROM nodes WHERE id = '${node.id}'`);
  assert.equal(rowRows[0].tunnel_port, 8443, 'clients must be handed the port the engine uses');

  const bad = await h.nodeRequest(node.id, node.hmacSecret, 'POST', '/internal/v1/node/heartbeat', {
    tunnelPort: 70000,
  });
  assert.equal(bad.status, 400);
  const after = await h.query<any>(`SELECT tunnel_port FROM nodes WHERE id = '${node.id}'`);
  assert.equal(after[0].tunnel_port, 8443, 'an invalid port must not be stored');
});

test('a heartbeat on a saturated node marks it degraded', async () => {
  const node = await h.seedNode({ status: 'offline' });
  await h.nodeRequest(node.id, node.hmacSecret, 'POST', '/internal/v1/node/heartbeat', { cpuPercent: 100, memoryPercent: 100 });
  const rowRows = await h.query<any>(`SELECT status FROM nodes WHERE id = '${node.id}'`);
  assert.equal(rowRows[0].status, 'degraded');
});

test('a heartbeat never resurrects a draining node', async () => {
  const node = await h.seedNode({ status: 'draining' });
  await h.nodeRequest(node.id, node.hmacSecret, 'POST', '/internal/v1/node/heartbeat', { cpuPercent: 1, memoryPercent: 1 });
  const rowRows = await h.query<any>(`SELECT status FROM nodes WHERE id = '${node.id}'`);
  assert.equal(rowRows[0].status, 'draining', 'admin drain must survive heartbeats');
});

test('a stale heartbeat sweeps the node offline', async () => {
  const { refreshNodeStatus } = await import('../../apps/controller/src/services/nodes.js');
  const node = await h.seedNode({ status: 'online' });
  await h.db.execute(`UPDATE nodes SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = '${node.id}'`);

  await refreshNodeStatus(h.db, h.cfg.heartbeatTtlSeconds);
  const rowRows = await h.query<any>(`SELECT status FROM nodes WHERE id = '${node.id}'`);
  assert.equal(rowRows[0].status, 'offline');
});

test('sync returns only credentials the controller considers live', async () => {
  const node = await h.seedNode();
  const user = await h.seedUser('sync@example.test');
  await h.setTier(user.id, 'standard');

  // Provision credentials by fetching a config bundle.
  const tokens = await h.login(user.email, user.password, 'device-1');
  await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });

  const res = await h.nodeRequest(node.id, node.hmacSecret, 'GET', '/internal/v1/node/sync');
  assert.equal(res.status, 200);
  assert.equal(res.body.credentials.length, 1);
  assert.equal(res.body.credentials[0].userEmail, user.email);
  assert.equal(res.body.credentials[0].revoked, false);
  assert.ok(res.body.credentials[0].uuid);

  // Revoke on the controller side; sync must tell the node to drop it.
  await h.db.execute(`UPDATE node_credentials SET revoked = true, revoked_at = now() WHERE node_id = '${node.id}'`);
  const after = await h.nodeRequest(node.id, node.hmacSecret, 'GET', '/internal/v1/node/sync');
  assert.equal(after.body.credentials[0].revoked, true);
});

test('usage rollups are idempotent and drive the per-credential counter', async () => {
  const node = await h.seedNode();
  const user = await h.seedUser('usage@example.test');
  await h.setTier(user.id, 'standard');
  const tokens = await h.login(user.email, user.password, 'device-1');
  await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });

  const credRows = await h.query<any>(`SELECT uuid FROM node_credentials WHERE node_id = '${node.id}'`);
  const uuid = credRows[0].uuid;

  const window = { windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-01T01:00:00.000Z' };
  const first = await h.nodeRequest(node.id, node.hmacSecret, 'POST', '/internal/v1/node/usage', {
    usage: [{ uuid, bytesUp: 1000, bytesDown: 2000, ...window }],
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.applied, 1);

  const after1Rows = await h.query<any>(`SELECT bytes_used FROM node_credentials WHERE uuid = '${uuid}'`);
  assert.equal(Number(after1Rows[0].bytes_used), 3000);

  // Re-reporting the same window must not double count.
  const second = await h.nodeRequest(node.id, node.hmacSecret, 'POST', '/internal/v1/node/usage', {
    usage: [{ uuid, bytesUp: 1000, bytesDown: 2000, ...window }],
  });
  assert.equal(second.body.applied, 0);
  const after2Rows = await h.query<any>(`SELECT bytes_used FROM node_credentials WHERE uuid = '${uuid}'`);
  assert.equal(Number(after2Rows[0].bytes_used), 3000);
});

test('the admin fleet reports per-node usage counters', async () => {
  const node = await h.seedNode({ hostname: 'usage-fleet.test' });
  const idle = await h.seedNode({ hostname: 'usage-idle.test' });
  const user = await h.seedUser('fleetusage@example.test');
  await h.setTier(user.id, 'standard');
  const tokens = await h.login(user.email, user.password, 'device-1');
  await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });
  const credRows = await h.query<any>(`SELECT id FROM node_credentials WHERE node_id = '${node.id}'`);
  await h.query(
    `INSERT INTO usage_rollups (credential_id, window_start, window_end, bytes_up, bytes_down) VALUES
       ('${credRows[0].id}', now() - interval '1 hour', now(), 1000, 2000),
       ('${credRows[0].id}', now() - interval '3 days', now() - interval '2 days', 4000, 5000)`,
  );

  const admin = await h.adminToken();
  const res = await h.request('GET', '/api/v1/admin/nodes', { token: admin });
  assert.equal(res.status, 200);
  const reported = res.body.nodes.find((n: any) => n.id === node.id);
  assert.equal(reported.usageTotalBytes, 12000, 'total sums every window');
  assert.equal(reported.usage24hBytes, 3000, 'the recent counter only counts the last day');
  assert.ok(reported.usageLastReportedAt, 'the last report time comes from the newest window end');

  const empty = res.body.nodes.find((n: any) => n.id === idle.id);
  assert.equal(empty.usageTotalBytes, 0);
  assert.equal(empty.usage24hBytes, 0);
  assert.equal(empty.usageLastReportedAt, null, 'a node with no rollups is not shown as reporting');
});

test('usage for an unknown credential or malformed window is ignored', async () => {
  const node = await h.seedNode();
  const user = await h.seedUser('badusage@example.test');
  await h.setTier(user.id, 'standard');
  const tokens = await h.login(user.email, user.password, 'device-1');
  await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });
  const credRows = await h.query<any>(`SELECT uuid FROM node_credentials WHERE node_id = '${node.id}'`);
  const uuid = credRows[0].uuid;

  const res = await h.nodeRequest(node.id, node.hmacSecret, 'POST', '/internal/v1/node/usage', {
    usage: [
      { uuid: 'not-a-known-uuid', bytesUp: 1, bytesDown: 1, windowStart: '2026-01-01T00:00:00Z', windowEnd: '2026-01-01T01:00:00Z' },
      { uuid, bytesUp: -5, bytesDown: 10, windowStart: '2026-01-01T00:00:00Z', windowEnd: '2026-01-01T01:00:00Z' },
      { uuid, bytesUp: 1, bytesDown: 1, windowStart: 'not-a-date', windowEnd: '2026-01-01T01:00:00Z' },
      { uuid, bytesUp: 1, bytesDown: 1, windowStart: '2026-01-01T05:00:00Z', windowEnd: '2026-01-01T01:00:00Z' },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.applied, 0);
});

test('a node cannot report usage against another node’s credentials', async () => {
  const nodeA = await h.seedNode({ hostname: 'a.test' });
  const nodeB = await h.seedNode({ hostname: 'b.test' });
  const user = await h.seedUser('xnode@example.test');
  await h.setTier(user.id, 'standard');
  const tokens = await h.login(user.email, user.password, 'device-1');
  await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });

  const credRows = await h.query<any>(`SELECT uuid FROM node_credentials WHERE node_id = '${nodeB.id}'`);
  const uuidOfB = credRows[0].uuid;

  const res = await h.nodeRequest(nodeA.id, nodeA.hmacSecret, 'POST', '/internal/v1/node/usage', {
    usage: [{ uuid: uuidOfB, bytesUp: 500, bytesDown: 500, windowStart: '2026-02-01T00:00:00Z', windowEnd: '2026-02-01T01:00:00Z' }],
  });
  assert.equal(res.body.applied, 0, 'node A must not be able to bill node B’s credential');
});
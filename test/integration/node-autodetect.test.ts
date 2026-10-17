/**
 * Integration tests for zero-touch node addressing.
 *
 * The Gatekeeper IP list origins trust is derived from `nodes.public_ip`, so
 * these flows decide what gets allowlisted: enrollment without an operator
 * supplied address, and a node healing its own address after its provider
 * re-issues it.
 *
 * Boots with `trustProxyHops: 1` so a test can present a client IP via
 * `X-Forwarded-For`, which is the only way to exercise the public-IP path
 * without a real remote peer.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';
import { applyObservedNodeIp } from '../../apps/controller/src/services/nodes.js';

let h: Harness;

before(async () => {
  h = await createHarness({ trustProxyHops: 1 });
});

after(async () => {
  await h.stop();
});

beforeEach(async () => {
  await h.resetDb();
});

async function enroll(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<any> {
  const token = await h.createEnrollment('eu-central');
  return h.request('POST', '/api/v1/nodes/enroll', {
    headers,
    body: {
      token,
      hostname: `node-${Math.random().toString(36).slice(2, 10)}.test`,
      realityServerName: 'www.microsoft.com',
      realityShortIds: ['0011223344556677'],
      ...body,
    },
  });
}

async function nodeRow(nodeId: string): Promise<any> {
  const rows = await h.query<any>(`SELECT public_ip, public_ip_source FROM nodes WHERE id = '${nodeId}'`);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

test('enrolling without a pinned IP records the address the node connected from', async () => {
  const res = await enroll({}, { 'x-forwarded-for': '203.0.113.21' });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const row = await nodeRow(res.body.nodeId);
  assert.equal(row.public_ip, '203.0.113.21');
  assert.equal(row.public_ip_source, 'autodetect');
});

test('an operator pinned IP is kept and marked as such', async () => {
  const res = await enroll({ publicIp: '198.51.100.44' });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const row = await nodeRow(res.body.nodeId);
  assert.equal(row.public_ip, '198.51.100.44');
  assert.equal(row.public_ip_source, 'enrollment');
});

test('a blank pinned IP is treated as "not supplied" and detection is used', async () => {
  const res = await enroll({ publicIp: '' }, { 'x-forwarded-for': '203.0.113.22' });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const row = await nodeRow(res.body.nodeId);
  assert.equal(row.public_ip, '203.0.113.22');
  assert.equal(row.public_ip_source, 'autodetect');
});

test('a private pinned IP is refused', async () => {
  const res = await enroll({ publicIp: '10.0.0.5' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION');
});

test('enrolling with no public address anywhere is a clear error, not a bad row', async () => {
  // No X-Forwarded-For and a loopback peer: there is no public address to use.
  const res = await enroll({});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'PUBLIC_IP_REQUIRED');
});

// ---------------------------------------------------------------------------
// Self-healing on heartbeat
// ---------------------------------------------------------------------------

test('a heartbeat reports the node address forward and the fleet list follows', async () => {
  const node = await h.seedNode({ status: 'online', publicIp: '203.0.113.50' });

  const beat = await h.nodeRequest(node.id, node.hmacSecret, 'POST', '/internal/v1/node/heartbeat', {
    cpuPercent: 1,
    memoryPercent: 1,
    bandwidthBytes: 0,
    uplinkRttMs: 12,
    uptimeSeconds: 100,
    engineVersion: '1.13.21',
    observedPublicIp: '203.0.113.99',
  });
  assert.equal(beat.status, 200, JSON.stringify(beat.body));

  const row = await nodeRow(node.id);
  assert.equal(row.public_ip, '203.0.113.99');
  assert.equal(row.public_ip_source, 'autodetect');

  // The allowlist the Gatekeeper polls must reflect the move immediately.
  const list = await h.request<{ ips: string[] }>('GET', '/api/v1/network/nodes/public-ips');
  assert.deepEqual(list.body.ips, ['203.0.113.99'], 'the stale address must not linger in the allowlist');
});

test('a private reported address is ignored', async () => {
  const node = await h.seedNode({ status: 'online', publicIp: '203.0.113.50' });
  const beat = await h.nodeRequest(node.id, node.hmacSecret, 'POST', '/internal/v1/node/heartbeat', {
    observedPublicIp: '10.1.2.3',
  });
  assert.equal(beat.status, 200);

  const row = await nodeRow(node.id);
  assert.equal(row.public_ip, '203.0.113.50', 'a private address must never replace a real one');
  assert.equal(row.public_ip_source, 'enrollment');
});

test('a heartbeat with no reported address leaves the stored one alone', async () => {
  const node = await h.seedNode({ status: 'online', publicIp: '203.0.113.50' });
  const beat = await h.nodeRequest(node.id, node.hmacSecret, 'POST', '/internal/v1/node/heartbeat', { cpuPercent: 2 });
  assert.equal(beat.status, 200);
  assert.equal((await nodeRow(node.id)).public_ip, '203.0.113.50');
});

test('re-reporting the same address is a no-op', async () => {
  const node = await h.seedNode({ status: 'online', publicIp: '203.0.113.50' });
  const report = { observedPublicIp: '203.0.113.50' };
  assert.equal((await h.nodeRequest(node.id, node.hmacSecret, 'POST', '/internal/v1/node/heartbeat', report)).status, 200);
  assert.equal((await nodeRow(node.id)).public_ip_source, 'enrollment', 'an unchanged address must not be relabelled');
});

test('auto-detection can be switched off entirely', async () => {
  const node = await h.seedNode({ status: 'online', publicIp: '203.0.113.50' });
  const result = await applyObservedNodeIp(h.db, { nodeIpAutodetect: false }, node.id, '203.0.113.99');
  assert.equal(result.changed, false);
  assert.equal((await nodeRow(node.id)).public_ip, '203.0.113.50');
});

test('an unknown node id is handled without throwing', async () => {
  const result = await applyObservedNodeIp(h.db, { nodeIpAutodetect: true }, '00000000-0000-0000-0000-000000000000', '203.0.113.1');
  assert.equal(result.changed, false);
  assert.equal(result.publicIp, null);
});

// ---------------------------------------------------------------------------
// Admin override
// ---------------------------------------------------------------------------

test('an admin editing the IP marks it as manual and rejects private values', async () => {
  const node = await h.seedNode({ status: 'online', publicIp: '203.0.113.50' });
  const admin = await h.adminToken();

  const bad = await h.request('PATCH', `/api/v1/admin/nodes/${node.id}`, { token: admin, body: { publicIp: '192.168.0.9' } });
  assert.equal(bad.status, 400);

  const ok = await h.request('PATCH', `/api/v1/admin/nodes/${node.id}`, { token: admin, body: { publicIp: '203.0.113.77' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  const row = await nodeRow(node.id);
  assert.equal(row.public_ip, '203.0.113.77');
  assert.equal(row.public_ip_source, 'manual');
});

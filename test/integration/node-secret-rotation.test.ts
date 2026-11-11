/**
 * Node HMAC secret rotation.
 *
 * The node's signing secret used to be immutable: a leak meant deleting the
 * node and enrolling it again, which also destroyed its REALITY keys and every
 * user credential on it. These tests pin the replacement contract — a new
 * secret authenticates immediately, the old one keeps working only for the
 * chosen grace window, and neither value is ever readable afterwards.
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

async function rotate(nodeId: string, body: Record<string, unknown> = {}) {
  const admin = await h.adminToken();
  return h.request('POST', `/api/v1/admin/nodes/${nodeId}/rotate-secret`, {
    token: admin,
    body,
  });
}

test('rotating a node secret requires an administrator', async () => {
  const node = await h.seedNode();
  const user = await h.seedUser('not-an-admin@example.test');
  const { accessToken } = await h.login(user.email, user.password, 'device-1');

  const res = await h.request('POST', `/api/v1/admin/nodes/${node.id}/rotate-secret`, {
    token: accessToken,
    body: {},
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});

test('rotation issues a new secret that authenticates immediately', async () => {
  const node = await h.seedNode();
  const res = await rotate(node.id, { graceHours: 24 });

  assert.equal(res.status, 201);
  assert.equal(res.body.nodeId, node.id);
  assert.ok(typeof res.body.secret === 'string' && res.body.secret.length > 20);
  assert.notEqual(res.body.secret, node.hmacSecret, 'the new secret must actually change');
  assert.ok(res.body.previousValidUntil, 'a default grace window is reported');

  const sync = await h.nodeRequest(node.id, res.body.secret, 'GET', '/internal/v1/node/sync');
  assert.equal(sync.status, 200, 'the node must be able to use the new secret right away');
});

test('the previous secret keeps working during the grace window', async () => {
  const node = await h.seedNode();
  await rotate(node.id, { graceHours: 24 });

  const sync = await h.nodeRequest(node.id, node.hmacSecret, 'GET', '/internal/v1/node/sync');
  assert.equal(sync.status, 200, 'the old secret must survive until the operator updates the node');
});

test('a zero-hour grace window retires the old secret immediately', async () => {
  const node = await h.seedNode();
  const res = await rotate(node.id, { graceHours: 0 });
  assert.equal(res.status, 201);
  assert.equal(res.body.previousValidUntil, null);

  const old = await h.nodeRequest(node.id, node.hmacSecret, 'GET', '/internal/v1/node/sync');
  assert.equal(old.status, 401);
  assert.equal(old.body.code, 'NODE_BAD_SIGNATURE');

  const fresh = await h.nodeRequest(node.id, res.body.secret, 'GET', '/internal/v1/node/sync');
  assert.equal(fresh.status, 200);
});

test('rotation is audited without either secret reaching the log', async () => {
  const node = await h.seedNode();
  const res = await rotate(node.id, { graceHours: 2 });

  const rows = await h.query<any>(
    `SELECT actor_email, action, target_type, target_id, summary, metadata FROM admin_audit_log WHERE action = 'node.secret_rotated'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target_type, 'node');
  assert.equal(rows[0].target_id, node.id);
  assert.match(rows[0].summary, /HMAC secret rotated/);

  const serialized = JSON.stringify(rows[0]);
  assert.ok(!serialized.includes(res.body.secret), 'the new secret must never be logged');
  assert.ok(!serialized.includes(node.hmacSecret), 'the old secret must never be logged');
});

test('rotation validates the node and the grace window', async () => {
  const missing = await rotate('00000000-0000-0000-0000-000000000000', { graceHours: 1 });
  assert.equal(missing.status, 404);

  const node = await h.seedNode();
  for (const graceHours of [-1, 169, 'soon']) {
    const invalid = await rotate(node.id, { graceHours });
    assert.equal(invalid.status, 400, `graceHours=${String(graceHours)} must be rejected`);
    assert.equal(invalid.body.code, 'VALIDATION');
  }
});

test('node secrets are not readable from the admin fleet route', async () => {
  const node = await h.seedNode();
  const rotated = await rotate(node.id, { graceHours: 24 });
  const admin = await h.adminToken();

  const list = await h.request('GET', '/api/v1/admin/nodes', { token: admin });
  assert.equal(list.status, 200);
  const serialized = JSON.stringify(list.body);
  assert.ok(!serialized.includes(node.hmacSecret));
  assert.ok(!serialized.includes(rotated.body.secret));
  assert.ok(!/hmac/i.test(serialized), 'the fleet view should not mention HMAC material at all');
});

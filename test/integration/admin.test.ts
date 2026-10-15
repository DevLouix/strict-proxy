/**
 * Integration tests for the admin control plane. Every route must require both
 * a valid JWT and the administrator role; a non-admin must never reach them.
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

const ADMIN_ROUTES: Array<[string, string, unknown]> = [
  ['GET', '/api/v1/admin/overview', undefined],
  ['GET', '/api/v1/admin/users', undefined],
  ['PATCH', '/api/v1/admin/users/00000000-0000-0000-0000-000000000000', { disabled: true }],
  ['PATCH', '/api/v1/admin/users/00000000-0000-0000-0000-000000000000/subscription', { tier: 'pro', status: 'active' }],
  ['GET', '/api/v1/admin/nodes', undefined],
  ['POST', '/api/v1/admin/nodes', {}],
  ['PATCH', '/api/v1/admin/nodes/00000000-0000-0000-0000-000000000000', { status: 'offline' }],
  ['DELETE', '/api/v1/admin/nodes/00000000-0000-0000-0000-000000000000', undefined],
  ['POST', '/api/v1/admin/node-enrollments', { region: 'eu-central' }],
  ['GET', '/api/v1/admin/node-enrollments', undefined],
  ['DELETE', '/api/v1/admin/node-enrollments/00000000-0000-0000-0000-000000000000', undefined],
  ['GET', '/api/v1/admin/payments/events', undefined],
];

test('every admin route rejects anonymous callers', async () => {
  for (const [method, path, body] of ADMIN_ROUTES) {
    const res = await h.request(method, path, { body });
    assert.equal(res.status, 401, `${method} ${path} must require authentication`);
    assert.equal(res.body.code, 'UNAUTHENTICATED');
  }
});

test('every admin route rejects an authenticated non-admin', async () => {
  const user = await h.seedUser('plain@example.test');
  const tokens = await h.login(user.email, user.password, 'device-1');

  for (const [method, path, body] of ADMIN_ROUTES) {
    const res = await h.request(method, path, { body, token: tokens.accessToken });
    assert.equal(res.status, 403, `${method} ${path} must reject a regular user`);
    assert.equal(res.body.code, 'FORBIDDEN');
  }
});

test('the overview reports fleet, user and subscription counts', async () => {
  const admin = await h.adminToken();
  await h.seedUser('a@example.test');
  await h.seedUser('b@example.test');
  await h.seedNode({ status: 'online' });
  await h.seedNode({ status: 'degraded' });
  await h.seedNode({ status: 'offline' });

  const res = await h.request('GET', '/api/v1/admin/overview', { token: admin });
  assert.equal(res.status, 200);
  assert.equal(res.body.onlineNodes, 2, 'degraded nodes still count as reachable');
  assert.ok(res.body.users >= 3);
  assert.equal(typeof res.body.activeSubscriptions, 'number');
  assert.equal(typeof res.body.activeCredentials, 'number');
});

test('disabling a user revokes their credentials and refresh tokens', async () => {
  const admin = await h.adminToken();
  const user = await h.seedUser('victim@example.test');
  await h.seedNode({ status: 'online' });
  const tokens = await h.login(user.email, user.password, 'device-1');
  await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });

  const creds = await h.query<any>(`SELECT revoked FROM node_credentials WHERE user_id = '${user.id}'`);
  assert.equal(creds.length, 1);
  assert.equal(creds[0].revoked, false);

  const res = await h.request('PATCH', `/api/v1/admin/users/${user.id}`, { token: admin, body: { disabled: true } });
  assert.equal(res.status, 200);
  assert.ok(res.body.user.disabledAt);

  const after = await h.query<any>(`SELECT revoked FROM node_credentials WHERE user_id = '${user.id}'`);
  assert.equal(after[0].revoked, true, 'credentials must be revoked on disable');

  const live = await h.query<any>(`SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = '${user.id}' AND revoked_at IS NULL`);
  assert.equal(live[0].n, 0, 'refresh tokens must be revoked on disable');

  // And the account can no longer authenticate.
  const login = await h.request('POST', '/api/v1/auth/login', {
    body: { email: user.email, password: user.password, deviceId: 'd' },
  });
  assert.equal(login.status, 401);
});

test('re-enabling a user clears the disabled flag', async () => {
  const admin = await h.adminToken();
  const user = await h.seedUser('reenable@example.test');
  await h.request('PATCH', `/api/v1/admin/users/${user.id}`, { token: admin, body: { disabled: true } });
  const res = await h.request('PATCH', `/api/v1/admin/users/${user.id}`, { token: admin, body: { disabled: false } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.disabledAt, null);
});

test('an invalid role is rejected', async () => {
  const admin = await h.adminToken();
  const user = await h.seedUser('rolecheck@example.test');
  const res = await h.request('PATCH', `/api/v1/admin/users/${user.id}`, { token: admin, body: { role: 'superuser' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION');
});

test('promoting a user to admin grants access on the next login', async () => {
  const admin = await h.adminToken();
  const user = await h.seedUser('promote@example.test');
  const res = await h.request('PATCH', `/api/v1/admin/users/${user.id}`, { token: admin, body: { role: 'admin' } });
  assert.equal(res.status, 200);

  const tokens = await h.login(user.email, user.password, 'device-1');
  const overview = await h.request('GET', '/api/v1/admin/overview', { token: tokens.accessToken });
  assert.equal(overview.status, 200);
});

test('setting a subscription to a non-active status revokes access', async () => {
  const admin = await h.adminToken();
  await h.seedNode({ status: 'online' });
  const user = await h.seedUser('sub@example.test');
  await h.setTier(user.id, 'pro');
  const tokens = await h.login(user.email, user.password, 'device-1');
  await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });

  const res = await h.request('PATCH', `/api/v1/admin/users/${user.id}/subscription`, {
    token: admin,
    body: { tier: 'pro', status: 'expired' },
  });
  assert.equal(res.status, 200);

  const config = await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });
  assert.equal(config.status, 402);
});

test('subscription updates validate tier, status and date', async () => {
  const admin = await h.adminToken();
  const user = await h.seedUser('badsub@example.test');

  const badTier = await h.request('PATCH', `/api/v1/admin/users/${user.id}/subscription`, {
    token: admin, body: { tier: 'platinum', status: 'active' },
  });
  assert.equal(badTier.status, 400);

  const badStatus = await h.request('PATCH', `/api/v1/admin/users/${user.id}/subscription`, {
    token: admin, body: { tier: 'pro', status: 'paused' },
  });
  assert.equal(badStatus.status, 400);

  const badDate = await h.request('PATCH', `/api/v1/admin/users/${user.id}/subscription`, {
    token: admin, body: { tier: 'pro', status: 'active', currentPeriodEnd: 'not-a-date' },
  });
  assert.equal(badDate.status, 400);
});

test('subscription can be set on a user that has no subscription row', async () => {
  const admin = await h.adminToken();
  const user = await h.seedUser('nosub@example.test');
  await h.query(`DELETE FROM subscriptions WHERE user_id = '${user.id}'`);

  const res = await h.request('PATCH', `/api/v1/admin/users/${user.id}/subscription`, {
    token: admin, body: { tier: 'pro', status: 'active' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.subscription.tier, 'pro');
});

test('node lifecycle transitions are validated', async () => {
  const admin = await h.adminToken();
  const node = await h.seedNode({ status: 'online' });

  const drained = await h.request('PATCH', `/api/v1/admin/nodes/${node.id}`, { token: admin, body: { status: 'draining' } });
  assert.equal(drained.status, 200);
  assert.equal(drained.body.node.status, 'draining');

  const badStatus = await h.request('PATCH', `/api/v1/admin/nodes/${node.id}`, { token: admin, body: { status: 'exploded' } });
  assert.equal(badStatus.status, 400);

  const badPort = await h.request('PATCH', `/api/v1/admin/nodes/${node.id}`, { token: admin, body: { tunnelPort: 99999 } });
  assert.equal(badPort.status, 400);

  const empty = await h.request('PATCH', `/api/v1/admin/nodes/${node.id}`, { token: admin, body: {} });
  assert.equal(empty.status, 400);

  const missing = await h.request('PATCH', '/api/v1/admin/nodes/00000000-0000-0000-0000-000000000000', { token: admin, body: { status: 'offline' } });
  assert.equal(missing.status, 404);
});

test('a node label can be cleared', async () => {
  const admin = await h.adminToken();
  const node = await h.seedNode({ status: 'online', label: 'Frankfurt 1' });
  const res = await h.request('PATCH', `/api/v1/admin/nodes/${node.id}`, { token: admin, body: { label: null } });
  assert.equal(res.status, 200);
  assert.equal(res.body.node.label, null);
});

test('deleting a node cascades to its credentials', async () => {
  const admin = await h.adminToken();
  await h.seedNode({ status: 'online' });
  const user = await h.seedUser('casc@example.test');
  const tokens = await h.login(user.email, user.password, 'device-1');
  await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });

  const before = await h.query<any>(`SELECT count(*)::int AS n FROM node_credentials`);
  assert.ok(before[0].n > 0);

  const nodes = await h.query<any>(`SELECT id FROM nodes`);
  for (const n of nodes) {
    const res = await h.request('DELETE', `/api/v1/admin/nodes/${n.id}`, { token: admin });
    assert.equal(res.status, 200);
  }

  const after = await h.query<any>(`SELECT count(*)::int AS n FROM node_credentials`);
  assert.equal(after[0].n, 0, 'credentials must cascade-delete with the node');

  const missing = await h.request('DELETE', '/api/v1/admin/nodes/00000000-0000-0000-0000-000000000000', { token: admin });
  assert.equal(missing.status, 404);
});

test('enrollment tokens can be listed and revoked', async () => {
  const admin = await h.adminToken();
  const created = await h.request('POST', '/api/v1/admin/node-enrollments', { token: admin, body: { region: 'eu-north', label: 'Stockholm' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.region, 'eu-north');
  assert.equal(typeof created.body.token, 'string');

  const list = await h.request('GET', '/api/v1/admin/node-enrollments', { token: admin });
  assert.equal(list.status, 200);
  assert.equal(list.body.enrollments.length, 1);
  assert.equal(list.body.enrollments[0].label, 'Stockholm');
  assert.equal('token' in list.body.enrollments[0], false, 'the raw token must never be listed back');

  const revoke = await h.request('DELETE', `/api/v1/admin/node-enrollments/${created.body.enrollmentId}`, { token: admin });
  assert.equal(revoke.status, 200);

  // A revoked token can no longer enroll a node.
  const enroll = await h.request('POST', '/api/v1/nodes/enroll', {
    body: {
      token: created.body.token,
      hostname: 'sto-1.example.com',
      publicIp: '203.0.113.60',
      realityServerName: 'www.microsoft.com',
      realityShortIds: ['0011223344556677'],
    },
  });
  assert.equal(enroll.status, 400);
});

test('enrollment requires a region and clamps the TTL', async () => {
  const admin = await h.adminToken();

  const noRegion = await h.request('POST', '/api/v1/admin/node-enrollments', { token: admin, body: { label: 'x' } });
  assert.equal(noRegion.status, 400);

  const clamped = await h.request('POST', '/api/v1/admin/node-enrollments', { token: admin, body: { region: 'eu-west', ttlMinutes: 1 } });
  assert.equal(clamped.status, 201);
  const ttlSeconds = (new Date(clamped.body.expiresAt).getTime() - Date.now()) / 1000;
  assert.ok(ttlSeconds >= 5 * 60 - 5, `ttl should be clamped up to the 5 minute floor, got ${ttlSeconds}s`);
});

test('the admin node list reports fleet health', async () => {
  const admin = await h.adminToken();
  await h.seedNode({ hostname: 'z.test', status: 'online', loadScore: 12 });
  await h.seedNode({ hostname: 'a.test', status: 'offline' });

  const res = await h.request('GET', '/api/v1/admin/nodes', { token: admin });
  assert.equal(res.status, 200);
  assert.equal(res.body.nodes.length, 2);
  // Ordered by region, then label, then hostname.
  assert.equal(res.body.nodes[0].hostname, 'a.test');
  assert.equal(typeof res.body.nodes[0].loadScore, 'number');
  assert.ok('lastHeartbeatAt' in res.body.nodes[0]);
});

test('the admin user list is paginated and bounded', async () => {
  const admin = await h.adminToken();
  for (let i = 0; i < 3; i++) await h.seedUser(`list${i}@example.test`);

  const res = await h.request('GET', '/api/v1/admin/users?limit=2', { token: admin });
  assert.equal(res.status, 200);
  assert.equal(res.body.users.length, 2);

  const overLimit = await h.request('GET', '/api/v1/admin/users?limit=9999', { token: admin });
  assert.ok(overLimit.body.users.length <= 200, 'limit must be clamped');
});
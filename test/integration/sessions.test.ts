/**
 * Integration tests for "one proxy session per account".
 *
 * The proxy cannot close a TCP connection a device already holds, so the
 * contract is: the newest install owns the session, the previous install's
 * credentials are revoked for the node to drop, and the previous install's
 * session id stops being accepted.
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

async function paidUser(deviceId = 'device-a') {
  const user = await h.seedUser(`session-${Math.random().toString(36).slice(2, 10)}@example.test`);
  await h.setTier(user.id, 'standard');
  const tokens = await h.login(user.email, user.password, deviceId);
  return { user, ...tokens };
}

async function claim(token: string, deviceId: string) {
  return h.request<{ sessionId: string; deviceId: string; superseded: any }>(
    'POST',
    '/api/v1/network/session',
    { token, body: { deviceId } },
  );
}

test('claiming a session requires a token and a device id', async () => {
  assert.equal((await h.request('POST', '/api/v1/network/session', { body: { deviceId: 'x' } })).status, 401);

  const { accessToken } = await paidUser();
  const missing = await h.request('POST', '/api/v1/network/session', { token: accessToken, body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'VALIDATION');
});

test('the first claim starts a session and config provisions that device', async () => {
  await h.seedNode({ status: 'online' });
  const { user, accessToken } = await paidUser('device-a');

  const claimed = await claim(accessToken, 'device-a');
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.ok(claimed.body.sessionId);
  assert.equal(claimed.body.deviceId, 'device-a');
  assert.equal(claimed.body.superseded, null);

  const config = await h.request('GET', '/api/v1/network/config', {
    token: accessToken,
    headers: { 'x-session-id': claimed.body.sessionId },
  });
  assert.equal(config.status, 200);

  const creds = await h.query<{ device_id: string; revoked: boolean }>(
    `SELECT device_id, revoked FROM node_credentials WHERE user_id = '${user.id}'`,
  );
  assert.equal(creds.length, 1);
  assert.equal(creds[0].device_id, 'device-a');
  assert.equal(creds[0].revoked, false);
});

test('a newer device wins and the older session closes', async () => {
  await h.seedNode({ status: 'online' });
  const { user, accessToken } = await paidUser('device-a');

  const first = await claim(accessToken, 'device-a');
  await h.request('GET', '/api/v1/network/config', {
    token: accessToken,
    headers: { 'x-session-id': first.body.sessionId },
  });

  const second = await claim(accessToken, 'device-b');
  assert.equal(second.status, 200);
  assert.notEqual(second.body.sessionId, first.body.sessionId);
  assert.equal(second.body.superseded.deviceId, 'device-a', 'the displaced install is named');

  // The old install learns it lost the session.
  const status = await h.request('GET', '/api/v1/network/session', {
    token: accessToken,
    headers: { 'x-session-id': first.body.sessionId },
  });
  assert.equal(status.status, 200);
  assert.equal(status.body.current, false);
  assert.equal(status.body.deviceId, 'device-b');

  const current = await h.request('GET', '/api/v1/network/session', {
    token: accessToken,
    headers: { 'x-session-id': second.body.sessionId },
  });
  assert.equal(current.body.current, true);

  // The old install is refused credentials rather than allowed to displace the
  // new device on a retry.
  const stale = await h.request('GET', '/api/v1/network/config', {
    token: accessToken,
    headers: { 'x-session-id': first.body.sessionId },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'SESSION_SUPERSEDED');

  // The new device's config works and the old credential is revoked on the node.
  const fresh = await h.request('GET', '/api/v1/network/config', {
    token: accessToken,
    headers: { 'x-session-id': second.body.sessionId },
  });
  assert.equal(fresh.status, 200);

  const creds = await h.query<{ device_id: string; revoked: boolean }>(
    `SELECT device_id, revoked FROM node_credentials WHERE user_id = '${user.id}' ORDER BY device_id`,
  );
  assert.deepEqual(
    creds.map((row) => [row.device_id, row.revoked]).sort(),
    [
      ['device-a', true],
      ['device-b', false],
    ],
    'exactly one live credential may remain, for the newest device',
  );

  // One row per account, no matter how many claims happened.
  const rows = await h.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM vpn_sessions WHERE user_id = '${user.id}'`,
  );
  assert.equal(rows[0].n, 1);
});

test('reconnecting from the same install keeps the session and its credentials', async () => {
  await h.seedNode({ status: 'online' });
  const { user, accessToken } = await paidUser('device-a');

  const first = await claim(accessToken, 'device-a');
  await h.request('GET', '/api/v1/network/config', {
    token: accessToken,
    headers: { 'x-session-id': first.body.sessionId },
  });

  const again = await claim(accessToken, 'device-a');
  assert.equal(again.body.sessionId, first.body.sessionId, 'same install keeps its session id');
  assert.equal(again.body.superseded, null);

  await h.request('GET', '/api/v1/network/config', {
    token: accessToken,
    headers: { 'x-session-id': first.body.sessionId },
  });

  const creds = await h.query<{ device_id: string; revoked: boolean }>(
    `SELECT device_id, revoked FROM node_credentials WHERE user_id = '${user.id}'`,
  );
  assert.equal(creds.length, 1);
  assert.equal(creds[0].revoked, false, 'a reconnect must not revoke its own credential');
});

test('a config request without a session id still works for older clients', async () => {
  await h.seedNode({ status: 'online' });
  const { accessToken } = await paidUser('device-a');
  await claim(accessToken, 'device-a');

  const res = await h.request('GET', '/api/v1/network/config', {
    token: accessToken,
    headers: { 'x-device-id': 'device-a' },
  });
  assert.equal(res.status, 200);
});

/**
 * Integration tests for the account's proxy seats.
 *
 * Seats are installs, not concurrent logins: a Standard account holds three
 * device rows, each with its own credential. A fourth install evicts the least
 * recently seen one, and the node drops that install's credentials on its next
 * sync. A credential cannot create a seat of its own, so sharing one UUID does
 * not let another person in — it occupies the seat it was issued to.
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
  // Standard = three device seats.
  await h.setTier(user.id, 'standard');
  const tokens = await h.login(user.email, user.password, deviceId);
  return { user, ...tokens };
}

async function claim(token: string, deviceId: string) {
  return h.request<{
    sessionId: string;
    deviceId: string;
    superseded: { deviceId: string } | null;
    activeDevices: number;
    seatLimit: number;
  }>('POST', '/api/v1/network/session', { token, body: { deviceId } });
}

async function config(token: string, sessionId: string) {
  return h.request('GET', '/api/v1/network/config', {
    token,
    headers: { 'x-session-id': sessionId },
  });
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
  assert.equal(claimed.body.seatLimit, 3);

  assert.equal((await config(accessToken, claimed.body.sessionId)).status, 200);

  const creds = await h.query<{ device_id: string; revoked: boolean }>(
    `SELECT device_id, revoked FROM node_credentials WHERE user_id = '${user.id}'`,
  );
  assert.equal(creds.length, 1);
  assert.equal(creds[0].device_id, 'device-a');
  assert.equal(creds[0].revoked, false);
});

test('every seat keeps its own live credential', async () => {
  await h.seedNode({ status: 'online' });
  const { user, accessToken } = await paidUser('device-a');

  const a = await claim(accessToken, 'device-a');
  assert.equal((await config(accessToken, a.body.sessionId)).status, 200);

  const b = await claim(accessToken, 'device-b');
  assert.equal(b.body.superseded, null, 'a second seat is not a displacement');
  assert.equal((await config(accessToken, b.body.sessionId)).status, 200);

  // The first device must not close itself down because another one connected.
  const statusA = await h.request('GET', '/api/v1/network/session', {
    token: accessToken,
    headers: { 'x-session-id': a.body.sessionId },
  });
  assert.equal(statusA.body.current, true);
  assert.equal(statusA.body.devices, 2);

  const creds = await h.query<{ device_id: string; revoked: boolean }>(
    `SELECT device_id, revoked FROM node_credentials WHERE user_id = '${user.id}' ORDER BY device_id`,
  );
  assert.deepEqual(
    creds.map((row) => [row.device_id, row.revoked]).sort(),
    [
      ['device-a', false],
      ['device-b', false],
    ],
    'each seated install keeps a live credential',
  );
});

test('an install beyond the seats evicts the least recently seen one', async () => {
  await h.seedNode({ status: 'online' });
  const { user, accessToken } = await paidUser('device-a');

  const a = await claim(accessToken, 'device-a');
  await config(accessToken, a.body.sessionId);
  const b = await claim(accessToken, 'device-b');
  await config(accessToken, b.body.sessionId);
  const c = await claim(accessToken, 'device-c');
  await config(accessToken, c.body.sessionId);

  const d = await claim(accessToken, 'device-d');
  assert.equal(d.status, 200);
  assert.equal(d.body.superseded?.deviceId, 'device-a', 'the stalest install is named');
  assert.equal(d.body.activeDevices, 3);
  assert.equal(d.body.seatLimit, 3);

  // The evicted install learns it holds no seat and is refused credentials.
  const evictedStatus = await h.request('GET', '/api/v1/network/session', {
    token: accessToken,
    headers: { 'x-session-id': a.body.sessionId },
  });
  assert.equal(evictedStatus.body.current, false);
  const stale = await config(accessToken, a.body.sessionId);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'SESSION_SUPERSEDED');

  assert.equal((await config(accessToken, d.body.sessionId)).status, 200);

  const creds = await h.query<{ device_id: string; revoked: boolean }>(
    `SELECT device_id, revoked FROM node_credentials WHERE user_id = '${user.id}' ORDER BY device_id`,
  );
  assert.deepEqual(
    creds.map((row) => [row.device_id, row.revoked]).sort(),
    [
      ['device-a', true],
      ['device-b', false],
      ['device-c', false],
      ['device-d', false],
    ],
    'the evicted install is the only one revoked',
  );

  // The account never holds more rows than its seats.
  const rows = await h.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM vpn_sessions WHERE user_id = '${user.id}'`,
  );
  assert.equal(rows[0].n, 3);
});

test('reconnecting from the same install keeps the session and its credentials', async () => {
  await h.seedNode({ status: 'online' });
  const { user, accessToken } = await paidUser('device-a');

  const first = await claim(accessToken, 'device-a');
  await config(accessToken, first.body.sessionId);

  const again = await claim(accessToken, 'device-a');
  assert.equal(again.body.sessionId, first.body.sessionId, 'same install keeps its session id');
  assert.equal(again.body.superseded, null);

  await config(accessToken, first.body.sessionId);

  const creds = await h.query<{ device_id: string; revoked: boolean }>(
    `SELECT device_id, revoked FROM node_credentials WHERE user_id = '${user.id}'`,
  );
  assert.equal(creds.length, 1);
  assert.equal(creds[0].revoked, false, 'a reconnect must not revoke its own credential');
});

test('a config request without a session id identifies the install from its token', async () => {
  await h.seedNode({ status: 'online' });
  const { user, accessToken } = await paidUser('device-a');
  await claim(accessToken, 'device-a');

  // An install that lost its local session header still holds the seat its
  // access token was minted for; the controller must not read it as a stranger.
  const res = await h.request('GET', '/api/v1/network/config', { token: accessToken });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const creds = await h.query<{ device_id: string; revoked: boolean }>(
    `SELECT device_id, revoked FROM node_credentials WHERE user_id = '${user.id}'`,
  );
  assert.deepEqual(
    creds.map((row) => [row.device_id, row.revoked]),
    [['device-a', false]],
    'credentials belong to the device named in the token',
  );
});

test('an install with no seat is told to reconnect, not that another device took over', async () => {
  await h.seedNode({ status: 'online' });
  const { user, accessToken } = await paidUser('device-a');
  // Rows exist for the account, so the seat check applies.
  await claim(accessToken, 'device-a');
  await claim(accessToken, 'device-b');

  // A token for an install that never claimed: same account, no seat of its own.
  const stranger = await h.login(user.email, user.password, 'device-c');
  const res = await h.request('GET', '/api/v1/network/config', { token: stranger.accessToken });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'SEAT_REQUIRED');
  assert.match(String(res.body.error), /does not hold a seat/);
});

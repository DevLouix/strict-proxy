/**
 * Integration tests for the account's proxy seats.
 *
 * Seats are installs, not concurrent logins: a Standard account holds three
 * device rows, each with its own credential. A fourth install evicts the least
 * recently seen one, and the node drops that install's credentials on its next
 * sync. A credential cannot create a seat of its own, so sharing one UUID does
 * not let another person in — it occupies the seat it was issued to.
 *
 * Every install here signs in for itself, because that is what mints the token
 * a real phone presents; a seat is whatever install id that token names.
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
  // Explicit: the login response also carries a `user` object, and spreading
  // it here replaces the seeded user with one that has no password — which made
  // a second login for the same account send no credentials at all.
  return { user, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

/** Signs in as one install, the way a separate phone would. */
async function install(email: string, password: string, deviceId: string) {
  return h.login(email, password, deviceId);
}

async function claim(token: string, body: { deviceId?: string } = {}) {
  return h.request<{
    sessionId: string;
    deviceId: string;
    superseded: { deviceId: string } | null;
    activeDevices: number;
    seatLimit: number;
  }>('POST', '/api/v1/network/session', { token, body });
}

async function config(token: string, sessionId: string) {
  return h.request('GET', '/api/v1/network/config', {
    token,
    headers: { 'x-session-id': sessionId },
  });
}

test('a claim needs a token and seats the install the token names', async () => {
  assert.equal((await h.request('POST', '/api/v1/network/session', { body: { deviceId: 'x' } })).status, 401);

  const { user, accessToken } = await paidUser('device-a');
  const claimed = await claim(accessToken);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.deviceId, 'device-a');

  // An id in the body that disagrees with the token cannot seat a second
  // install: one phone whose local id drifted must not consume two seats and
  // leave itself without the seat its token would match.
  const drifted = await claim(accessToken, { deviceId: 'device-stale' });
  assert.equal(drifted.body.deviceId, 'device-a');
  const rows = await h.query<{ device_id: string }>(
    `SELECT device_id FROM vpn_sessions WHERE user_id = '${user.id}'`,
  );
  assert.deepEqual(
    rows.map((row) => row.device_id),
    ['device-a'],
    'the seat follows the token, not the body',
  );
});

test('the first claim starts a session and config provisions that device', async () => {
  await h.seedNode({ status: 'online' });
  const { user, accessToken } = await paidUser('device-a');

  const claimed = await claim(accessToken);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.ok(claimed.body.sessionId);
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

  const a = await claim(accessToken);
  assert.equal((await config(accessToken, a.body.sessionId)).status, 200);

  const bTokens = await install(user.email, user.password, 'device-b');
  const b = await claim(bTokens.accessToken);
  assert.equal(b.body.superseded, null, 'a second seat is not a displacement');
  assert.equal((await config(bTokens.accessToken, b.body.sessionId)).status, 200);

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

  const a = await claim(accessToken);
  await config(accessToken, a.body.sessionId);
  for (const deviceId of ['device-b', 'device-c']) {
    const tokens = await install(user.email, user.password, deviceId);
    const claimed = await claim(tokens.accessToken);
    await config(tokens.accessToken, claimed.body.sessionId);
  }

  const dTokens = await install(user.email, user.password, 'device-d');
  const d = await claim(dTokens.accessToken);
  assert.equal(d.status, 200);
  assert.equal(d.body.superseded?.deviceId, 'device-a', 'the stalest install is named');
  assert.equal(d.body.activeDevices, 3);
  assert.equal(d.body.seatLimit, 3);
  assert.equal((await config(dTokens.accessToken, d.body.sessionId)).status, 200);

  // The evicted install learns it holds no seat and is refused credentials.
  const evictedStatus = await h.request('GET', '/api/v1/network/session', {
    token: accessToken,
    headers: { 'x-session-id': a.body.sessionId },
  });
  assert.equal(evictedStatus.body.current, false);
  const stale = await config(accessToken, a.body.sessionId);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'SESSION_SUPERSEDED');

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

  const first = await claim(accessToken);
  await config(accessToken, first.body.sessionId);

  const again = await claim(accessToken);
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
  await claim(accessToken);

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

test('config seats an authenticated install that never claimed', async () => {
  await h.seedNode({ status: 'online' });
  const { user, accessToken } = await paidUser('device-a');

  const seats: Record<string, string> = {};
  for (const deviceId of ['device-a', 'device-b', 'device-c']) {
    const tokens = deviceId === 'device-a' ? { accessToken } : await install(user.email, user.password, deviceId);
    const claimed = await claim(tokens.accessToken);
    seats[deviceId] = claimed.body.sessionId;
    assert.equal((await config(tokens.accessToken, claimed.body.sessionId)).status, 200);
  }

  // A build from before the claim call, or one whose local install id was
  // regenerated after signing in, arrives with a token and no session id. It
  // is authenticated as this account, so it must be seated rather than told
  // its account is in use — which is what happened to a user with one phone.
  const late = await install(user.email, user.password, 'device-d');
  const res = await h.request('GET', '/api/v1/network/config', { token: late.accessToken });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const rows = await h.query<{ device_id: string }>(
    `SELECT device_id FROM vpn_sessions WHERE user_id = '${user.id}' ORDER BY device_id`,
  );
  assert.deepEqual(
    rows.map((row) => row.device_id),
    ['device-b', 'device-c', 'device-d'],
    'the seat displaced the stalest install instead of exceeding the plan',
  );

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
    'the displaced install loses its credential',
  );

  // And it is told plainly, through the session it already holds.
  const displaced = await config(accessToken, seats['device-a']!);
  assert.equal(displaced.status, 409);
  assert.equal(displaced.body.code, 'SESSION_SUPERSEDED');
});

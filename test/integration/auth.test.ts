/**
 * Integration tests for the account/auth surface against real Postgres + Redis.
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

const PASSWORD = 'a sufficiently long password';

test('register creates an account on the free tier and rejects duplicates', async () => {
  const first = await h.request('POST', '/api/v1/auth/register', {
    body: { email: 'User@Example.test', password: PASSWORD },
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.user.email, 'user@example.test', 'email should be lowercased');
  assert.equal(first.body.user.role, 'user');
  assert.equal(first.body.user.tier, 'free');

  const dup = await h.request('POST', '/api/v1/auth/register', {
    body: { email: 'user@example.test', password: PASSWORD },
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'EMAIL_TAKEN');
});

test('register rejects missing fields and short passwords', async () => {
  for (const body of [
    {},
    { email: 'a@example.test' },
    { password: PASSWORD },
    { email: 'a@example.test', password: 'short' },
    { email: '', password: PASSWORD },
  ]) {
    const res = await h.request('POST', '/api/v1/auth/register', { body });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(res.body.code, 'VALIDATION');
  }
});

test('login returns an access/refresh pair and identifies the user', async () => {
  const user = await h.seedUser('login@example.test');
  const res = await h.request('POST', '/api/v1/auth/login', {
    body: { email: user.email, password: user.password, deviceId: 'device-a' },
  });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.accessToken, 'string');
  assert.equal(typeof res.body.refreshToken, 'string');
  assert.equal(res.body.user.email, user.email);
  assert.equal(res.body.expiresIn, h.cfg.accessTokenTtlSeconds);
});

test('login rejects wrong password, unknown user and missing deviceId', async () => {
  const user = await h.seedUser('wrongpw@example.test');

  const badPw = await h.request('POST', '/api/v1/auth/login', {
    body: { email: user.email, password: 'not the password', deviceId: 'd' },
  });
  assert.equal(badPw.status, 401);
  assert.equal(badPw.body.code, 'INVALID_CREDENTIALS');

  const unknown = await h.request('POST', '/api/v1/auth/login', {
    body: { email: 'nobody@example.test', password: user.password, deviceId: 'd' },
  });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.code, 'INVALID_CREDENTIALS', 'must not reveal whether the account exists');

  const noDevice = await h.request('POST', '/api/v1/auth/login', {
    body: { email: user.email, password: user.password },
  });
  assert.equal(noDevice.status, 400);
});

test('a disabled account cannot log in', async () => {
  const user = await h.seedUser('disabled@example.test');
  await h.db.execute(`UPDATE users SET disabled_at = now() WHERE email = 'disabled@example.test'`);

  const res = await h.request('POST', '/api/v1/auth/login', {
    body: { email: user.email, password: user.password, deviceId: 'd' },
  });
  assert.equal(res.status, 401);
});

test('a revoked subscription blocks login with 403', async () => {
  const user = await h.seedUser('revoked@example.test');
  await h.db.execute(`UPDATE subscriptions SET status = 'revoked' WHERE user_id = '${user.id}'`);

  const res = await h.request('POST', '/api/v1/auth/login', {
    body: { email: user.email, password: user.password, deviceId: 'd' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'SUBSCRIPTION_REVOKED');
});

test('/api/v1/me requires a token and returns the profile with devices', async () => {
  const user = await h.seedUser('me@example.test');
  const { accessToken } = await h.login(user.email, user.password, 'device-1');

  const anon = await h.request('GET', '/api/v1/me');
  assert.equal(anon.status, 401);
  assert.equal(anon.body.code, 'UNAUTHENTICATED');

  const res = await h.request('GET', '/api/v1/me', { token: accessToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, user.email);
  assert.equal(Array.isArray(res.body.devices), true);
  assert.equal(res.body.devices.some((d: any) => d.deviceId === 'device-1'), true);
});

test('garbage and tampered access tokens are rejected', async () => {
  for (const token of ['not-a-jwt', 'a.b.c']) {
    const res = await h.request('GET', '/api/v1/me', { token });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'UNAUTHENTICATED');
  }
});

test('refresh rotates the token pair and invalidates the old refresh token', async () => {
  const user = await h.seedUser('refresh@example.test');
  const first = await h.login(user.email, user.password, 'device-1');

  const rotated = await h.request('POST', '/api/v1/auth/refresh', {
    body: { refreshToken: first.refreshToken, deviceId: 'device-1' },
  });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.refreshToken, first.refreshToken);

  // Single-use: replaying the consumed token must fail.
  const replay = await h.request('POST', '/api/v1/auth/refresh', {
    body: { refreshToken: first.refreshToken, deviceId: 'device-1' },
  });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.code, 'INVALID_REFRESH');
});

test('refresh is bound to the device it was issued for', async () => {
  const user = await h.seedUser('bind@example.test');
  const tokens = await h.login(user.email, user.password, 'device-1');

  const res = await h.request('POST', '/api/v1/auth/refresh', {
    body: { refreshToken: tokens.refreshToken, deviceId: 'device-2' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'INVALID_REFRESH');
});

test('logout revokes the presented access token immediately', async () => {
  const user = await h.seedUser('logout@example.test');
  const { accessToken } = await h.login(user.email, user.password, 'device-1');

  assert.equal((await h.request('GET', '/api/v1/me', { token: accessToken })).status, 200);

  const logout = await h.request('POST', '/api/v1/auth/logout', { token: accessToken });
  assert.equal(logout.status, 200);

  const after = await h.request('GET', '/api/v1/me', { token: accessToken });
  assert.equal(after.status, 401);
  assert.equal(after.body.code, 'TOKEN_REVOKED');
});

test('device seats evict the least-recently-seen device rather than refusing', async () => {
  await h.request('POST', '/api/v1/auth/register', { body: { email: 'seats@example.test', password: PASSWORD } });

  // Free tier allows a single seat, so signing in on a second device must
  // reclaim the seat from the first device instead of failing.
  const first = await h.request('POST', '/api/v1/auth/login', {
    body: { email: 'seats@example.test', password: PASSWORD, deviceId: 'seat-1' },
  });
  assert.equal(first.status, 200, 'first seat should be granted');

  const second = await h.request('POST', '/api/v1/auth/login', {
    body: { email: 'seats@example.test', password: PASSWORD, deviceId: 'seat-2' },
  });
  assert.equal(second.status, 200, 'second login should reclaim the seat');

  // The evicted device's refresh token must stop working.
  const evicted = await h.request('POST', '/api/v1/auth/refresh', {
    body: { refreshToken: first.body.refreshToken, deviceId: 'seat-1' },
  });
  assert.equal(evicted.status, 401);

  const kept = await h.request('POST', '/api/v1/auth/refresh', {
    body: { refreshToken: second.body.refreshToken, deviceId: 'seat-2' },
  });
  assert.equal(kept.status, 200);

  // Exactly one seat remains occupied.
  const live = await h.db.execute(
    `SELECT count(DISTINCT device_row_id) AS live FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > now()`,
  );
  assert.equal(Number((live as any).rows[0].live), 1);
});

test('a role change in the database invalidates an already-issued token', async () => {
  const user = await h.seedUser('demoted@example.test', 'admin');
  const { accessToken } = await h.login(user.email, user.password, 'device-1');

  assert.equal((await h.request('GET', '/api/v1/me', { token: accessToken })).status, 200);

  // Privilege guard: a token minted with role=admin must stop working the
  // moment the account's role no longer matches the claim.
  await h.db.execute(`UPDATE users SET role = 'user' WHERE email = 'demoted@example.test'`);
  const res = await h.request('GET', '/api/v1/me', { token: accessToken });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'ACCOUNT_UNAVAILABLE');
});

test('unknown routes return a JSON 404', async () => {
  const res = await h.request('GET', '/api/v1/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
});

test('health and readiness reflect dependency state', async () => {
  assert.equal((await h.request('GET', '/healthz')).status, 200);
  const ready = await h.request('GET', '/readyz');
  assert.equal(ready.status, 200);
  assert.equal(ready.body.ok, true);
});
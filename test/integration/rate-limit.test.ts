/**
 * Rate limiting is enforced per endpoint bucket, so this suite boots its own
 * harness with a deliberately tiny budget. Each test asserts within a single
 * window; the harness flushes limiter keys between tests.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, SEED_PASSWORD, type Harness } from '../helpers/harness.js';

const MAX = 3;

let h: Harness;

before(async () => {
  // One trusted hop lets the suite vary the apparent client IP via
  // X-Forwarded-For to prove the limiter is scoped per client.
  h = await createHarness({ rateLimitMaxAttempts: MAX, rateLimitWindowSeconds: 60, trustProxyHops: 1 });
});

after(async () => {
  await h.stop();
});

const PASSWORD = SEED_PASSWORD;

test('login is throttled after the configured number of attempts', async () => {
  await h.resetDb();
  await h.seedUser('rl-login@example.test', 'admin');

  for (let i = 0; i < MAX; i++) {
    const res = await h.request('POST', '/api/v1/auth/login', {
      body: { email: 'rl-login@example.test', password: PASSWORD, deviceId: `d${i}` },
    });
    assert.equal(res.status, 200, `attempt ${i + 1} should be within budget`);
    assert.equal(res.headers.get('x-ratelimit-limit'), String(MAX));
    assert.equal(res.headers.get('x-ratelimit-remaining'), String(MAX - (i + 1)));
  }

  const blocked = await h.request('POST', '/api/v1/auth/login', {
    body: { email: 'rl-login@example.test', password: PASSWORD, deviceId: 'overflow' },
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'RATE_LIMITED');
  assert.equal(blocked.headers.get('retry-after'), '60');
});

test('throttling blocks brute force but never leaks credential validity', async () => {
  await h.resetDb();
  const user = await h.seedUser('rl-brute@example.test');

  // Every attempt past the budget is rejected identically.
  for (let i = 0; i < MAX; i++) {
    await h.request('POST', '/api/v1/auth/login', { body: { email: user.email, password: 'wrong', deviceId: 'b' } });
  }
  const first = await h.request('POST', '/api/v1/auth/login', { body: { email: user.email, password: 'wrong', deviceId: 'b' } });
  const second = await h.request('POST', '/api/v1/auth/login', { body: { email: user.email, password: 'wrong', deviceId: 'b' } });

  assert.equal(first.status, 429);
  assert.equal(second.status, 429);
  assert.deepEqual(first.body, second.body, 'identical throttled responses');
  assert.equal('user' in first.body, false);
});

test('the login bucket does not consume the registration budget', async () => {
  await h.resetDb();

  for (let i = 0; i < MAX; i++) {
    await h.request('POST', '/api/v1/auth/login', { body: { email: 'nobody@example.test', password: 'x'.repeat(12), deviceId: 'd' } });
  }
  assert.equal((await h.request('POST', '/api/v1/auth/login', { body: { email: 'nobody@example.test', password: 'x'.repeat(12), deviceId: 'd' } })).status, 429);

  // Registration is a separate bucket and still has its full budget.
  const reg = await h.request('POST', '/api/v1/auth/register', { body: { email: 'rl-reg@example.test', password: PASSWORD } });
  assert.equal(reg.status, 201);
});

test('registration is throttled independently', async () => {
  await h.resetDb();
  const statuses: number[] = [];
  for (let i = 0; i < MAX + 1; i++) {
    const res = await h.request('POST', '/api/v1/auth/register', {
      body: { email: `rl-bulk-${i}@example.test`, password: PASSWORD },
    });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses.slice(0, MAX), [201, 201, 201]);
  assert.equal(statuses[MAX], 429);
});

test('refresh is throttled on its own bucket', async () => {
  await h.resetDb();
  const user = await h.seedUser('rl-refresh@example.test');

  for (let i = 0; i < MAX + 1; i++) {
    const res = await h.request('POST', '/api/v1/auth/refresh', { body: { refreshToken: 'invalid', deviceId: 'd' } });
    if (i === MAX) assert.equal(res.status, 429);
    else assert.equal(res.status, 401);
  }
});

test('authenticated endpoints are not rate limited', async () => {
  await h.resetDb();
  await h.seedNode({ status: 'online' });
  const user = await h.seedUser('rl-jwt@example.test');
  const tokens = await h.login(user.email, user.password, 'device-1');

  // Well past the auth budget: a normal client must never be throttled here.
  for (let i = 0; i < MAX * 4; i++) {
    const res = await h.request('GET', '/api/v1/me', { token: tokens.accessToken });
    assert.equal(res.status, 200);
  }
});

test('the enrollment endpoint is throttled', async () => {
  await h.resetDb();
  const statuses: number[] = [];
  for (let i = 0; i < MAX + 1; i++) {
    const res = await h.request('POST', '/api/v1/nodes/enroll', {
      body: { token: 'nope', hostname: 'x.test', publicIp: '203.0.113.1', realityServerName: 'www.microsoft.com', realityShortIds: ['aa'] },
    });
    statuses.push(res.status);
  }
  assert.equal(statuses[MAX], 429, 'the unauthenticated enrollment surface must be throttled');
});

test('the payment webhook is throttled', async () => {
  await h.resetDb();
  const statuses: number[] = [];
  for (let i = 0; i < MAX + 1; i++) {
    const res = await h.request('POST', '/webhooks/payments', { rawBody: JSON.stringify({ id: `rl-${i}`, type: 'checkout.completed' }) });
    statuses.push(res.status);
  }
  assert.equal(statuses[MAX], 429, 'signature verification must not be an unbounded amplification vector');
});

test('limiter counters are scoped per client IP', async () => {
  await h.resetDb();
  await h.seedUser('rl-ip@example.test');

  for (let i = 0; i < MAX; i++) {
    await h.request('POST', '/api/v1/auth/login', {
      body: { email: 'rl-ip@example.test', password: 'wrong', deviceId: 'd' },
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
  }
  const blocked = await h.request('POST', '/api/v1/auth/login', {
    body: { email: 'rl-ip@example.test', password: 'wrong', deviceId: 'd' },
    headers: { 'x-forwarded-for': '198.51.100.7' },
  });
  assert.equal(blocked.status, 429);

  // A different client address has its own budget.
  const other = await h.request('POST', '/api/v1/auth/login', {
    body: { email: 'rl-ip@example.test', password: 'wrong', deviceId: 'd' },
    headers: { 'x-forwarded-for': '198.51.100.8' },
  });
  assert.equal(other.status, 401, 'a different IP must not inherit the first IP’s budget');
});
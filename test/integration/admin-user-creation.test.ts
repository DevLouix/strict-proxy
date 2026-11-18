/**
 * Creating accounts from the dashboard.
 *
 * The route is part of the admin control plane, so it is refused to anonymous
 * callers and to regular users by `admin.test.ts`'s route table. Here the
 * successful path and its guardrails: the account can sign in, starts on the
 * free tier, cannot be duplicated, and every creation is attributed in the
 * audit log.
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

const PASSWORD = 'correct horse battery';

test('an administrator can create a user that can sign in', async () => {
  const admin = await h.adminToken();

  const res = await h.request('POST', '/api/v1/admin/users', {
    token: admin,
    body: { email: 'New.User@Example.test', password: PASSWORD },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, 'new.user@example.test', 'the address is normalised');
  assert.equal(res.body.user.role, 'user');

  const login = await h.request('POST', '/api/v1/auth/login', {
    body: { email: 'new.user@example.test', password: PASSWORD, deviceId: 'device-1' },
  });
  assert.equal(login.status, 200, 'the created account can authenticate');

  const subs = await h.query<any>(
    `SELECT tier, status FROM subscriptions WHERE user_id = '${res.body.user.id}'`,
  );
  assert.deepEqual(subs, [{ tier: 'free', status: 'active' }], 'a free subscription exists immediately');
});

test('creating a user is audited with the acting administrator', async () => {
  const admin = await h.adminToken();
  const [actor] = await h.query<any>(`SELECT email FROM users WHERE role = 'admin' LIMIT 1`);

  const res = await h.request('POST', '/api/v1/admin/users', {
    token: admin,
    body: { email: 'audited@example.test', password: PASSWORD },
  });
  assert.equal(res.status, 201);

  const rows = await h.query<any>(
    `SELECT action, actor_email, target_id, metadata FROM admin_audit_log WHERE action = 'user.created'`,
  );
  assert.equal(rows.length, 1, 'exactly one audit entry');
  assert.equal(rows[0].target_id, res.body.user.id);
  if (actor) assert.equal(rows[0].actor_email, actor.email);
  assert.equal(rows[0].metadata.role, 'user');
});

test('an administrator can create another administrator', async () => {
  const admin = await h.adminToken();

  const res = await h.request('POST', '/api/v1/admin/users', {
    token: admin,
    body: { email: 'second-admin@example.test', password: PASSWORD, role: 'admin' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, 'admin');

  const tokens = await h.login('second-admin@example.test', PASSWORD, 'device-2');
  const overview = await h.request('GET', '/api/v1/admin/overview', { token: tokens.accessToken });
  assert.equal(overview.status, 200, 'the new administrator can administer');
});

test('a duplicate email is refused', async () => {
  await h.seedUser('taken@example.test');
  const admin = await h.adminToken();

  const res = await h.request('POST', '/api/v1/admin/users', {
    token: admin,
    body: { email: 'taken@example.test', password: PASSWORD },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'EMAIL_TAKEN');
});

test('a short password and an unknown role create nothing', async () => {
  const admin = await h.adminToken();

  const short = await h.request('POST', '/api/v1/admin/users', {
    token: admin,
    body: { email: 'short@example.test', password: 'short' },
  });
  assert.equal(short.status, 400);

  const badRole = await h.request('POST', '/api/v1/admin/users', {
    token: admin,
    body: { email: 'role@example.test', password: PASSWORD, role: 'superuser' },
  });
  assert.equal(badRole.status, 400);

  const [count] = await h.query<any>(
    `SELECT count(*)::int AS count FROM users WHERE email IN ('short@example.test', 'role@example.test')`,
  );
  assert.equal(count.count, 0, 'a rejected request must not leave an account behind');
});

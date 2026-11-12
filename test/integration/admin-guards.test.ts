/**
 * An administrator must not be able to remove its own access.
 *
 * Demoting, disabling or deleting the account you are signed in as has no undo:
 * the next request is refused and only a database edit recovers the deployment.
 * The dashboard hides nothing, so these are enforced server-side and asserted
 * here at the HTTP level — the rule has to hold for a curl request too.
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

test('an administrator cannot demote its own account', async () => {
  const admin = await h.seedUser('root-demote@example.test', 'admin');
  const tokens = await h.login(admin.email, admin.password, 'admin-device');

  const res = await h.request('PATCH', `/api/v1/admin/users/${admin.id}`, {
    token: tokens.accessToken,
    body: { role: 'user' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'SELF_DEMOTION');

  // The refusal must not half-apply: the caller is still an administrator.
  const overview = await h.request('GET', '/api/v1/admin/overview', { token: tokens.accessToken });
  assert.equal(overview.status, 200);
});

test('an administrator cannot disable its own account', async () => {
  const admin = await h.seedUser('root-disable@example.test', 'admin');
  const tokens = await h.login(admin.email, admin.password, 'admin-device');

  const res = await h.request('PATCH', `/api/v1/admin/users/${admin.id}`, {
    token: tokens.accessToken,
    body: { disabled: true },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'SELF_DISABLE');

  const overview = await h.request('GET', '/api/v1/admin/overview', { token: tokens.accessToken });
  assert.equal(overview.status, 200);
});

test('an administrator cannot delete its own account', async () => {
  const admin = await h.seedUser('root-delete@example.test', 'admin');
  const tokens = await h.login(admin.email, admin.password, 'admin-device');

  // The password is correct, so the refusal is the self-delete guard rather than
  // the confirmation check in front of it.
  const res = await h.request('DELETE', '/api/v1/me', {
    token: tokens.accessToken,
    body: { password: admin.password },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ROOT_SELF_DELETE');

  const overview = await h.request('GET', '/api/v1/admin/overview', { token: tokens.accessToken });
  assert.equal(overview.status, 200);
});

test('an administrator can still be demoted by another administrator', async () => {
  const root = await h.seedUser('root-actor@example.test', 'admin');
  const other = await h.seedUser('second-admin@example.test', 'admin');
  const tokens = await h.login(root.email, root.password, 'admin-device');

  const res = await h.request('PATCH', `/api/v1/admin/users/${other.id}`, {
    token: tokens.accessToken,
    body: { role: 'user' },
  });
  assert.equal(res.status, 200, 'the guard is self-protection, not a ban on demotion');
  assert.equal(res.body.user.role, 'user');
});

test('an ordinary user can still delete their own account', async () => {
  const user = await h.seedUser('plain-delete@example.test');
  const tokens = await h.login(user.email, user.password, 'device-1');

  const res = await h.request('DELETE', '/api/v1/me', {
    token: tokens.accessToken,
    body: { password: user.password },
  });
  assert.equal(res.status, 200);

  const login = await h.request('POST', '/api/v1/auth/login', {
    body: { email: user.email, password: user.password, deviceId: 'device-2' },
  });
  assert.equal(login.status, 401, 'the account is gone');
});

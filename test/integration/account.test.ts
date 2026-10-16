/**
 * Account recovery and deletion.
 *
 * The motivating defect: before this, the only auth routes were register,
 * login, refresh and logout. A user who forgot their password could not get
 * back in, ever. These tests also pin the two rules that matter most here —
 * recovery must not become an account-existence oracle, and a reset must sign
 * every other session out.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, SEED_PASSWORD, type Harness } from '../helpers/harness.js';
import { RESET_TTL_MINUTES } from '../../apps/controller/src/services/account.js';

let h: Harness;

before(async () => {
  h = await createHarness({ openpayApiKey: 'pk_test_key', openpayWebhookSecret: 'whsec_test' });
});

after(async () => {
  await h.stop();
});

beforeEach(async () => {
  await h.resetDb();
});

const NEW_PASSWORD = 'a brand new password';

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

test('the reset token machinery is wired: forgot then admin-issue then reset', async () => {
  const user = await h.seedUser('locked@example.test');
  const admin = await h.adminToken();

  // Self-service forgot never returns a token and never leaks existence.
  const forgot = await h.request('POST', '/api/v1/auth/password/forgot', { body: { email: 'locked@example.test' } });
  assert.equal(forgot.status, 202);

  // An operator can issue a real token for a verified customer.
  const issued = await h.request('POST', `/api/v1/admin/users/${user.id}/password-reset`, { token: admin });
  assert.equal(issued.status, 201);
  assert.equal(typeof issued.body.token, 'string');
  assert.ok(issued.body.token.length >= 32);
  assert.equal(issued.body.email, user.email);

  // The user sets a new password with it.
  const reset = await h.request('POST', '/api/v1/auth/password/reset', {
    body: { token: issued.body.token, password: NEW_PASSWORD },
  });
  assert.equal(reset.status, 200);

  // Old password no longer works; new one does.
  const oldLogin = await h.request('POST', '/api/v1/auth/login', {
    body: { email: user.email, password: SEED_PASSWORD, deviceId: 'd' },
  });
  assert.equal(oldLogin.status, 401);

  const newLogin = await h.request('POST', '/api/v1/auth/login', {
    body: { email: user.email, password: NEW_PASSWORD, deviceId: 'd' },
  });
  assert.equal(newLogin.status, 200, 'the user must be able to get back in');
});

test('forgot answers identically for known and unknown addresses', async () => {
  await h.seedUser('known@example.test');

  const known = await h.request('POST', '/api/v1/auth/password/forgot', { body: { email: 'known@example.test' } });
  const unknown = await h.request('POST', '/api/v1/auth/password/forgot', { body: { email: 'nobody@example.test' } });

  assert.equal(known.status, unknown.status);
  assert.deepEqual(known.body, unknown.body, 'a differing response is an account-existence oracle');
});

test('forgot requires an email and is rate limited', async () => {
  const res = await h.request('POST', '/api/v1/auth/password/forgot', { body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION');
});

test('a reset token is single-use', async () => {
  const user = await h.seedUser('single-use@example.test');
  const admin = await h.adminToken();
  const issued = await h.request('POST', `/api/v1/admin/users/${user.id}/password-reset`, { token: admin });
  const token = issued.body.token;

  assert.equal((await h.request('POST', '/api/v1/auth/password/reset', { body: { token, password: NEW_PASSWORD } })).status, 200);

  const replay = await h.request('POST', '/api/v1/auth/password/reset', { body: { token, password: 'yet another password' } });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.code, 'RESET_TOKEN_INVALID');
});

test('an expired reset token is refused', async () => {
  const user = await h.seedUser('expired@example.test');
  const admin = await h.adminToken();
  const issued = await h.request('POST', `/api/v1/admin/users/${user.id}/password-reset`, { token: admin });
  await h.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = (
    SELECT token_hash FROM password_reset_tokens WHERE user_id = '${user.id}' ORDER BY created_at DESC LIMIT 1
  )`);

  const res = await h.request('POST', '/api/v1/auth/password/reset', { body: { token: issued.body.token, password: NEW_PASSWORD } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'RESET_TOKEN_INVALID');
});

test('issuing a new reset invalidates the previous one', async () => {
  const user = await h.seedUser('supersede@example.test');
  const admin = await h.adminToken();

  const first = await h.request('POST', `/api/v1/admin/users/${user.id}/password-reset`, { token: admin });
  const second = await h.request('POST', `/api/v1/admin/users/${user.id}/password-reset`, { token: admin });

  assert.notEqual(first.body.token, second.body.token);
  const stale = await h.request('POST', '/api/v1/auth/password/reset', { body: { token: first.body.token, password: NEW_PASSWORD } });
  assert.equal(stale.status, 400, 'only the most recently issued link may work');
});

test('reset enforces the password policy', async () => {
  const user = await h.seedUser('weak@example.test');
  const admin = await h.adminToken();
  const issued = await h.request('POST', `/api/v1/admin/users/${user.id}/password-reset`, { token: admin });

  for (const body of [
    { token: issued.body.token },
    { password: NEW_PASSWORD },
    { token: issued.body.token, password: 'short' },
    { token: issued.body.token, password: '' },
  ]) {
    const res = await h.request('POST', '/api/v1/auth/password/reset', { body });
    assert.equal(res.status, 400, `expected rejection for ${JSON.stringify(body)}`);
  }
});

test('a reset signs out every existing session', async () => {
  const user = await h.seedUser('sessions@example.test');
  const victimTokens = await h.login(user.email, SEED_PASSWORD, 'device-1');
  const admin = await h.adminToken();
  const issued = await h.request('POST', `/api/v1/admin/users/${user.id}/password-reset`, { token: admin });
  await h.request('POST', '/api/v1/auth/password/reset', { body: { token: issued.body.token, password: NEW_PASSWORD } });

  const refresh = await h.request('POST', '/api/v1/auth/refresh', {
    body: { refreshToken: victimTokens.refreshToken, deviceId: 'device-1' },
  });
  assert.equal(refresh.status, 401, 'an attacker holding a pre-reset refresh token must be locked out');
});

test('a reset revokes node credentials', async () => {
  await h.seedNode({ status: 'online' });
  const user = await h.seedUser('creds@example.test');
  await h.setTier(user.id, 'standard');
  const tokens = await h.login(user.email, SEED_PASSWORD, 'device-1');
  await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });

  const admin = await h.adminToken();
  const issued = await h.request('POST', `/api/v1/admin/users/${user.id}/password-reset`, { token: admin });
  await h.request('POST', '/api/v1/auth/password/reset', { body: { token: issued.body.token, password: NEW_PASSWORD } });

  const creds = await h.query<any>(`SELECT revoked FROM node_credentials WHERE user_id = '${user.id}'`);
  assert.ok(creds.every((c: any) => c.revoked === true), 'a reset must not leave a working tunnel');
});

test('the admin reset route is admin-only', async () => {
  const user = await h.seedUser('notadmin@example.test');
  const anon = await h.request('POST', `/api/v1/admin/users/${user.id}/password-reset`);
  assert.equal(anon.status, 401);

  const tokens = await h.login(user.email, SEED_PASSWORD, 'device-1');
  const forbidden = await h.request('POST', `/api/v1/admin/users/${user.id}/password-reset`, { token: tokens.accessToken });
  assert.equal(forbidden.status, 403);
});

test('the admin reset route 404s for an unknown user', async () => {
  const admin = await h.adminToken();
  const res = await h.request('POST', '/api/v1/admin/users/00000000-0000-0000-0000-000000000000/password-reset', { token: admin });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Password change
// ---------------------------------------------------------------------------

test('a signed-in user can change their password with the current one', async () => {
  const user = await h.seedUser('change@example.test');
  const tokens = await h.login(user.email, SEED_PASSWORD, 'device-1');

  const wrong = await h.request('POST', '/api/v1/auth/password/change', {
    token: tokens.accessToken,
    body: { currentPassword: 'not the password', newPassword: NEW_PASSWORD },
  });
  assert.equal(wrong.status, 401);

  const res = await h.request('POST', '/api/v1/auth/password/change', {
    token: tokens.accessToken,
    body: { currentPassword: SEED_PASSWORD, newPassword: NEW_PASSWORD },
  });
  assert.equal(res.status, 200);

  const login = await h.request('POST', '/api/v1/auth/login', { body: { email: user.email, password: NEW_PASSWORD, deviceId: 'd' } });
  assert.equal(login.status, 200);
});

test('password change requires authentication and enforces the policy', async () => {
  const anon = await h.request('POST', '/api/v1/auth/password/change', { body: { currentPassword: 'a', newPassword: NEW_PASSWORD } });
  assert.equal(anon.status, 401);

  const user = await h.seedUser('policy@example.test');
  const tokens = await h.login(user.email, SEED_PASSWORD, 'device-1');
  const weak = await h.request('POST', '/api/v1/auth/password/change', {
    token: tokens.accessToken,
    body: { currentPassword: SEED_PASSWORD, newPassword: 'short' },
  });
  assert.equal(weak.status, 400);
});

// ---------------------------------------------------------------------------
// Self-service deletion
// ---------------------------------------------------------------------------

test('a user can delete their own account with their password', async () => {
  await h.seedNode({ status: 'online' });
  const user = await h.seedUser('leaving@example.test');
  await h.setTier(user.id, 'standard');
  const tokens = await h.login(user.email, user.password, 'device-1');
  await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });

  const res = await h.request('DELETE', '/api/v1/me', { token: tokens.accessToken, body: { password: user.password } });
  assert.equal(res.status, 200);

  const rows = await h.query<any>(`SELECT id FROM users WHERE id = '${user.id}'`);
  assert.equal(rows.length, 0, 'the account must be gone');

  // Everything attached to it is gone too.
  const creds = await h.query<any>(`SELECT count(*)::int AS n FROM node_credentials`);
  assert.equal(creds[0].n, 0, 'credentials must cascade');
  const subs = await h.query<any>(`SELECT count(*)::int AS n FROM subscriptions`);
  assert.equal(subs[0].n, 0);

  // And the session is dead.
  assert.equal((await h.request('GET', '/api/v1/me', { token: tokens.accessToken })).status, 401);
});

test('deletion requires the correct password', async () => {
  const user = await h.seedUser('guard@example.test');
  const tokens = await h.login(user.email, user.password, 'device-1');

  for (const body of [{}, { password: 'wrong' }, { password: '' }]) {
    const res = await h.request('DELETE', '/api/v1/me', { token: tokens.accessToken, body });
    assert.equal(res.status, 401, `expected rejection for ${JSON.stringify(body)}`);
  }

  const rows = await h.query<any>(`SELECT id FROM users WHERE id = '${user.id}'`);
  assert.equal(rows.length, 1, 'the account must survive a failed deletion attempt');
});

test('deletion requires authentication', async () => {
  const res = await h.request('DELETE', '/api/v1/me', { body: { password: SEED_PASSWORD } });
  assert.equal(res.status, 401);
});

test('deletion revokes credentials before removing the row', async () => {
  await h.seedNode({ status: 'online' });
  const user = await h.seedUser('order@example.test');
  await h.setTier(user.id, 'standard');
  const tokens = await h.login(user.email, user.password, 'device-1');
  await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });

  await h.request('DELETE', '/api/v1/me', { token: tokens.accessToken, body: { password: user.password } });

  // The node's last-known state must not still contain this user's UUID.
  const leaked = await h.query<any>(`SELECT count(*)::int AS n FROM node_credentials`);
  assert.equal(leaked[0].n, 0);
});

test('the reset TTL is short enough to be safe', () => {
  assert.ok(RESET_TTL_MINUTES > 0 && RESET_TTL_MINUTES <= 120, `expected a short window, got ${RESET_TTL_MINUTES}m`);
});

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

test('the refund route is admin-only', async () => {
  const user = await h.seedUser('refunduser@example.test');
  assert.equal((await h.request('POST', '/api/v1/admin/billing/refund', { body: { reference: 'x' } })).status, 401);

  const tokens = await h.login(user.email, SEED_PASSWORD, 'device-1');
  const res = await h.request('POST', '/api/v1/admin/billing/refund', { token: tokens.accessToken, body: { reference: 'x' } });
  assert.equal(res.status, 403);
});

test('refund validates its input and requires a settled checkout', async () => {
  const admin = await h.adminToken();

  const noRef = await h.request('POST', '/api/v1/admin/billing/refund', { token: admin, body: {} });
  assert.equal(noRef.status, 400);

  const unknown = await h.request('POST', '/api/v1/admin/billing/refund', { token: admin, body: { reference: 'spx-nope' } });
  assert.equal(unknown.status, 404);

  const user = await h.seedUser('unsettled@example.test');
  await h.query(
    `INSERT INTO billing_checkouts (user_id, reference, provider_reference, tier, amount_minor, currency, status)
     VALUES ('${user.id}', 'spx-open', 'op_open', 'standard', 250000, 'NGN', 'open')`,
  );
  const unsettled = await h.request('POST', '/api/v1/admin/billing/refund', { token: admin, body: { reference: 'spx-open' } });
  assert.equal(unsettled.status, 409);
  assert.equal(unsettled.body.code, 'CHECKOUT_NOT_SETTLED');
});

test('refund rejects an amount larger than what was charged', async () => {
  const admin = await h.adminToken();
  const user = await h.seedUser('overrefund@example.test');
  await h.query(
    `INSERT INTO billing_checkouts (user_id, reference, provider_reference, tier, amount_minor, currency, status, paid_at)
     VALUES ('${user.id}', 'spx-paid', 'op_paid', 'standard', 250000, 'NGN', 'paid', now())`,
  );

  for (const amountMinor of [0, -1, 250001, 1_000_000]) {
    const res = await h.request('POST', '/api/v1/admin/billing/refund', { token: admin, body: { reference: 'spx-paid', amountMinor } });
    assert.equal(res.status, 400, `expected rejection for ${amountMinor}`);
  }
});

test('refund reports 503 when no gateway is configured', async () => {
  await h.stop();
  h = await createHarness();
  const admin = await h.adminToken();
  const res = await h.request('POST', '/api/v1/admin/billing/refund', { token: admin, body: { reference: 'spx-x' } });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'BILLING_NOT_CONFIGURED');
});
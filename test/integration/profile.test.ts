/**
 * Self-service profile changes.
 *
 * The email is both the sign-in identifier and the recovery address, so moving
 * it must require the current password: an access token alone must not be able
 * to point an account at an address its holder controls.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, SEED_PASSWORD, type Harness } from '../helpers/harness.js';

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

test('a signed-in user can change their email with their password', async () => {
  const user = await h.seedUser('before@example.test');
  const tokens = await h.login(user.email, SEED_PASSWORD, 'device-1');

  const wrong = await h.request('POST', '/api/v1/auth/email/change', {
    token: tokens.accessToken,
    body: { email: 'after@example.test', password: 'not the password' },
  });
  assert.equal(wrong.status, 401);

  const res = await h.request('POST', '/api/v1/auth/email/change', {
    token: tokens.accessToken,
    body: { email: 'after@example.test', password: SEED_PASSWORD },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'after@example.test');

  // The account moved: the old address no longer signs in or recovers.
  const oldLogin = await h.request('POST', '/api/v1/auth/login', {
    body: { email: 'before@example.test', password: SEED_PASSWORD, deviceId: 'd' },
  });
  assert.equal(oldLogin.status, 401);

  const newLogin = await h.request('POST', '/api/v1/auth/login', {
    body: { email: 'after@example.test', password: SEED_PASSWORD, deviceId: 'd' },
  });
  assert.equal(newLogin.status, 200);

  // The existing session stays valid and reports the new address.
  const me = await h.request('GET', '/api/v1/me', { token: tokens.accessToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'after@example.test');
});

test('email change refuses an address another account owns', async () => {
  await h.seedUser('taken@example.test');
  const user = await h.seedUser('mine@example.test');
  const tokens = await h.login(user.email, SEED_PASSWORD, 'device-1');

  const res = await h.request('POST', '/api/v1/auth/email/change', {
    token: tokens.accessToken,
    body: { email: 'Taken@Example.test', password: SEED_PASSWORD },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'EMAIL_TAKEN');
});

test('email change requires authentication and a valid address', async () => {
  const anon = await h.request('POST', '/api/v1/auth/email/change', {
    body: { email: 'nobody@example.test', password: SEED_PASSWORD },
  });
  assert.equal(anon.status, 401);

  const user = await h.seedUser('validate@example.test');
  const tokens = await h.login(user.email, SEED_PASSWORD, 'device-1');

  for (const email of ['not-an-email', '', 'missing@domain']) {
    const res = await h.request('POST', '/api/v1/auth/email/change', {
      token: tokens.accessToken,
      body: { email, password: SEED_PASSWORD },
    });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(email)}`);
  }
});

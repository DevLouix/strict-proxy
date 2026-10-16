/**
 * Operator-configured SMTP settings and outbound mail.
 *
 * The behaviour that matters most here is what happens when mail is *not*
 * configured: a reset must still succeed for the user-facing flow, and must
 * never leak the token that would let anyone take over an account.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';
import { encryptSecret, decryptSecret, settingsKey, isEncrypted } from '../../apps/controller/src/services/settings.js';
import {
  validateSmtpSettings,
  resetLink,
  passwordResetEmail,
  invalidateMailTransport,
} from '../../apps/controller/src/services/mail.js';

let h: Harness;

before(async () => {
  h = await createHarness();
});

after(async () => {
  await h.stop();
});

beforeEach(async () => {
  await h.resetDb();
  invalidateMailTransport();
});

const SMTP_BODY = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  username: 'postmaster@example.com',
  password: 'hunter2-not-a-real-password',
  fromAddress: 'no-reply@strictproxy.example',
  fromName: 'StrictProxy',
};

/** Puts the harness into "mail is configured" state. */
async function configureSmtp(overrides: Record<string, unknown> = {}): Promise<void> {
  const res = await h.request('PUT', '/api/v1/admin/settings/email', {
    token: await h.adminToken(),
    body: { ...SMTP_BODY, ...overrides },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

// ---------------------------------------------------------------------------
// Secrets at rest
// ---------------------------------------------------------------------------

test('a secret round-trips through encryption', () => {
  const key = settingsKey(h.cfg);
  const stored = encryptSecret('correct horse battery staple', key);
  assert.notEqual(stored, 'correct horse battery staple');
  assert.equal(decryptSecret(stored, key), 'correct horse battery staple');
});

test('encryption is randomised, so equal values do not look equal', () => {
  const key = settingsKey(h.cfg);
  assert.notEqual(encryptSecret('same', key), encryptSecret('same', key));
});

test('decrypting with the wrong key fails rather than returning garbage', () => {
  const stored = encryptSecret('secret', settingsKey(h.cfg));
  assert.throws(() => decryptSecret(stored, Buffer.alloc(32, 1)));
});

test('decrypting tampered ciphertext fails', () => {
  const key = settingsKey(h.cfg);
  const stored = encryptSecret('secret', key);
  const parts = stored.split(':');
  // Flip a character in the ciphertext body.
  const data = parts[4];
  parts[4] = (data[0] === 'A' ? 'B' : 'A') + data.slice(1);
  assert.throws(() => decryptSecret(parts.join(':'), key));
});

test('decrypting refuses plaintext that claims to be a secret', () => {
  // Guards against a row written without encryption being silently used as if
  // it were protected.
  assert.throws(() => decryptSecret('just-a-password', settingsKey(h.cfg)));
  assert.equal(isEncrypted('enc:v1:a:b:c'), true);
  assert.equal(isEncrypted('plain'), false);
});

// ---------------------------------------------------------------------------
// Settings API
// ---------------------------------------------------------------------------

test('mail settings are admin-only', async () => {
  assert.equal((await h.request('GET', '/api/v1/admin/settings/email')).status, 401);

  const user = await h.seedUser('nosy@example.test');
  const tokens = await h.login(user.email, user.password, 'device-1');
  assert.equal((await h.request('GET', '/api/v1/admin/settings/email', { token: tokens.accessToken })).status, 403);
  assert.equal((await h.request('PUT', '/api/v1/admin/settings/email', { token: tokens.accessToken, body: SMTP_BODY })).status, 403);
});

test('the saved password is never readable', async () => {
  await configureSmtp();

  const res = await h.request('GET', '/api/v1/admin/settings/email', { token: await h.adminToken() });
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, true);
  assert.equal(res.body.summary.passwordSet, true, 'the operator is told a password exists');
  assert.equal(res.body.summary.password, undefined, 'but never what it is');

  const serialised = JSON.stringify(res.body);
  assert.ok(!serialised.includes(SMTP_BODY.password), `the password leaked in the response: ${serialised}`);

  // Nor anywhere in the database.
  const rows = await h.query<any>(`SELECT value FROM platform_settings WHERE key = 'smtp.password'`);
  assert.equal(rows.length, 1);
  assert.ok(!String(rows[0].value).includes(SMTP_BODY.password), 'the password is stored in plaintext');
  assert.equal(rows[0].value.startsWith('enc:v1:'), true);
});

test('settings round-trip without touching the password', async () => {
  await configureSmtp();

  // Changing the host must not wipe the password.
  const res = await h.request('PUT', '/api/v1/admin/settings/email', {
    token: await h.adminToken(),
    body: { host: 'smtp2.example.com' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.updated, ['host']);

  const after = await h.request('GET', '/api/v1/admin/settings/email', { token: await h.adminToken() });
  assert.equal(after.body.summary.host, 'smtp2.example.com');
  assert.equal(after.body.summary.passwordSet, true, 'the untouched password must survive');
});

test('an empty password clears it rather than being ignored', async () => {
  await configureSmtp();
  const res = await h.request('PUT', '/api/v1/admin/settings/email', {
    token: await h.adminToken(),
    body: { password: '' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.clearedSecretPassword, true);

  const after = await h.request('GET', '/api/v1/admin/settings/email', { token: await h.adminToken() });
  assert.equal(after.body.summary.passwordSet, false);
});

test('invalid settings are rejected before anything is written', async () => {
  const admin = await h.adminToken();

  for (const body of [
    { port: 0 },
    { port: 70_000 },
    { port: 'not-a-number' },
    { fromAddress: 'not-an-email' },
    { fromAddress: 'missing@domain' },
    { host: '' },
  ]) {
    const res = await h.request('PUT', '/api/v1/admin/settings/email', { token: admin, body });
    assert.equal(res.status, 400, `expected rejection for ${JSON.stringify(body)}`);
  }

  const rows = await h.query<any>(`SELECT count(*)::int AS n FROM platform_settings`);
  assert.equal(rows[0].n, 0, 'a rejected save must not leave partial settings behind');
});

test('a save with no recognised field is rejected', async () => {
  const res = await h.request('PUT', '/api/v1/admin/settings/email', {
    token: await h.adminToken(),
    body: { nothing: 'useful' },
  });
  assert.equal(res.status, 400);
});

test('deleting settings disables mail', async () => {
  await configureSmtp();
  const res = await h.request('DELETE', '/api/v1/admin/settings/email', { token: await h.adminToken() });
  assert.equal(res.status, 200);

  const rows = await h.query<any>(`SELECT count(*)::int AS n FROM platform_settings`);
  assert.equal(rows[0].n, 0);
  assert.equal((await h.request('GET', '/api/v1/admin/settings/email', { token: await h.adminToken() })).body.configured, false);
});

test('port 465 implies implicit TLS, other ports imply STARTTLS', async () => {
  // Port 465 is implicit TLS; the stored flag is omitted so the port decides.
  await configureSmtp({ port: 465, secure: undefined });
  let res = await h.request('GET', '/api/v1/admin/settings/email', { token: await h.adminToken() });
  assert.equal(res.body.summary.secure, true, '465 is implicit TLS');

  await configureSmtp({ port: 587, secure: undefined });
  res = await h.request('GET', '/api/v1/admin/settings/email', { token: await h.adminToken() });
  assert.equal(res.body.summary.secure, false, '587 upgrades with STARTTLS');
});

test('an explicit secure flag overrides the port default', async () => {
  // Some relays use implicit TLS on a non-standard port.
  await configureSmtp({ port: 587, secure: true });
  const res = await h.request('GET', '/api/v1/admin/settings/email', { token: await h.adminToken() });
  assert.equal(res.body.summary.secure, true);
});

test('validateSmtpSettings names the offending field', () => {
  const errors = validateSmtpSettings({ port: 99_999, fromAddress: 'bad' });
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.includes('port')));
  assert.ok(errors.some((e) => e.includes('fromAddress')));
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

test('the test-send endpoint reports mail that is not configured', async () => {
  const res = await h.request('POST', '/api/v1/admin/settings/email/test', {
    token: await h.adminToken(),
    body: { to: 'ops@example.com' },
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'MAIL_NOT_CONFIGURED');
});

test('the test-send endpoint requires a real recipient', async () => {
  const admin = await h.adminToken();
  await configureSmtp();
  for (const to of ['', 'nope', 'a@b', '@example.com']) {
    const res = await h.request('POST', '/api/v1/admin/settings/email/test', { token: admin, body: { to } });
    assert.equal(res.status, 400, `expected rejection for ${JSON.stringify(to)}`);
  }
});

test('a test send against an unreachable server fails without leaking the password', async () => {
  // 203.0.113.0/24 is TEST-NET-3: reserved for documentation, never routable.
  await configureSmtp({ host: '203.0.113.1', port: 2525, username: 'u', password: 'sup3r-s3cret-value' });
  const res = await h.request('POST', '/api/v1/admin/settings/email/test', {
    token: await h.adminToken(),
    body: { to: 'ops@example.com' },
  });
  assert.equal(res.status, 502, 'configured but unreachable is a different failure from unconfigured');
  assert.equal(res.body.code, 'MAIL_SEND_FAILED');
  assert.ok(!JSON.stringify(res.body).includes('sup3r-s3cret-value'), 'the error must not carry credentials');
});

// ---------------------------------------------------------------------------
// Reset delivery
// ---------------------------------------------------------------------------

test('forgot never returns the token, even with mail configured', async () => {
  await configureSmtp();
  const res = await h.request('POST', '/api/v1/auth/password/forgot', { body: { email: 'anyone@example.test' } });
  assert.equal(res.status, 202);
  assert.ok(!JSON.stringify(res.body).includes('token'));
});

test('forgot still succeeds when mail is not configured', async () => {
  // The token is issued and the operator relays it. Failing closed here would
  // leave users with no recovery path at all.
  const res = await h.request('POST', '/api/v1/auth/password/forgot', { body: { email: 'nobody@example.test' } });
  assert.equal(res.status, 202);
});

test('the operator email route reports mail that is not configured', async () => {
  const user = await h.seedUser('nomail@example.test');
  const res = await h.request('POST', `/api/v1/admin/users/${user.id}/password-reset/email`, { token: await h.adminToken() });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'MAIL_NOT_CONFIGURED');
});

test('the operator email route 404s for an unknown user', async () => {
  const res = await h.request('POST', '/api/v1/admin/users/00000000-0000-0000-0000-000000000000/password-reset/email', {
    token: await h.adminToken(),
  });
  assert.equal(res.status, 404);
});

test('the operator email route is admin-only', async () => {
  const user = await h.seedUser('plain@example.test');
  assert.equal((await h.request('POST', `/api/v1/admin/users/${user.id}/password-reset/email`)).status, 401);
});

test('lapse notices report per-user outcomes instead of one boolean', async () => {
  const user = await h.seedUser('lapsed@example.test');
  await h.query(`UPDATE subscriptions SET status = 'expired', current_period_end = now() - interval '1 day' WHERE user_id = '${user.id}'`);

  const res = await h.request('POST', '/api/v1/admin/billing/lapse-notices', { token: await h.adminToken(), body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.attempted, 1);
  assert.equal(res.body.delivered, 0, 'mail is not configured, so nothing was delivered');
  assert.equal(res.body.failed, 1);
  assert.equal(res.body.results[0].reason, 'not_configured');
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

test('the reset link points at the configured public app URL', () => {
  assert.equal(resetLink(h.cfg, 'abc'), `${h.cfg.publicAppUrl}/reset-password?token=abc`);
  assert.equal(resetLink(h.cfg, 'a b/c'), `${h.cfg.publicAppUrl}/reset-password?token=a%20b%2Fc`, 'the token is encoded');
});

test('the reset email carries a usable link and says it works once', () => {
  const template = passwordResetEmail(h.cfg, 'tok-123', 30);
  assert.match(template.text, /reset-password\?token=tok-123/);
  assert.match(template.text, /30 minutes/);
  assert.match(template.text, /works once/i);
  assert.ok(template.html.includes('tok-123'), 'the HTML part carries the link too');
  assert.ok(template.subject.length > 0);
});

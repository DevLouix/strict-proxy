/**
 * First-run bootstrap: `/setup` must create exactly one platform root admin,
 * and must stop existing the moment one is present.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';

const ROOT_PASSWORD = 'a-long-root-password';

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

async function adminCount(): Promise<number> {
  const rows = await h.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`);
  return rows[0]!.n;
}

test('the setup page is served while no administrator exists', async () => {
  const res = await h.request('GET', '/setup');
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type') ?? ''), /text\/html/);
  assert.match(String(res.body), /<form method="post" action="\/setup"/);
  assert.match(String(res.body), /name="email"/);
  assert.match(String(res.body), /name="password"/);
  assert.equal(res.headers.get('cache-control'), 'no-store, must-revalidate');
  assert.match(String(res.headers.get('content-security-policy') ?? ''), /default-src 'none'/);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('posting credentials creates the root admin with a paid tier', async () => {
  const res = await h.request('POST', '/setup', { body: { email: '  Root@Example.Test ', password: ROOT_PASSWORD } });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, 'root@example.test', 'the email is normalized');
  assert.equal(res.body.user.role, 'admin');

  assert.equal(await adminCount(), 1, 'exactly one admin is created');

  const rows = await h.query<any>(
    `SELECT u.email, u.role, s.tier, s.status
       FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
      WHERE u.email = 'root@example.test'`,
  );
  assert.equal(rows[0].role, 'admin');
  assert.equal(rows[0].tier, 'pro');
  assert.equal(rows[0].status, 'active');
});

test('the new root admin can sign in and use the admin API', async () => {
  const created = await h.request('POST', '/setup', { body: { email: 'root@example.test', password: ROOT_PASSWORD } });
  assert.equal(created.status, 201);

  const tokens = await h.login('root@example.test', ROOT_PASSWORD, 'bootstrap-device');
  const overview = await h.request('GET', '/api/v1/admin/overview', { token: tokens.accessToken });
  assert.equal(overview.status, 200);
});

test('setup disappears once a root admin exists', async () => {
  await h.seedUser('existing@example.test', 'admin');

  const page = await h.request('GET', '/setup');
  assert.equal(page.status, 404, 'the page must not be reachable after bootstrap');
  assert.equal(page.body.code, 'NOT_FOUND');

  const submit = await h.request('POST', '/setup', { body: { email: 'second@example.test', password: ROOT_PASSWORD } });
  assert.equal(submit.status, 404, 'the bootstrap endpoint must 404 too, not 403');
  assert.equal(await adminCount(), 1, 'no second admin is created');

  const rows = await h.query<any>(`SELECT email FROM users WHERE email = 'second@example.test'`);
  assert.equal(rows.length, 0, 'the rejected submission must not leave an account behind');
});

test('the gate is re-evaluated per request, so setup locks itself', async () => {
  assert.equal((await h.request('GET', '/setup')).status, 200);
  assert.equal((await h.request('POST', '/setup', { body: { email: 'root@example.test', password: ROOT_PASSWORD } })).status, 201);
  assert.equal((await h.request('GET', '/setup')).status, 404);
});

test('weak or malformed credentials are refused without creating an admin', async () => {
  const cases: Array<Record<string, unknown>> = [
    { email: 'not-an-email', password: ROOT_PASSWORD },
    { email: 'root@example.test', password: 'short' },
    { email: 'root@example.test', password: 'x'.repeat(201) },
    { email: 'root@example.test', password: ROOT_PASSWORD, confirm: 'different-password' },
    {},
  ];

  for (const body of cases) {
    const res = await h.request('POST', '/setup', { body });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(res.body.code, 'VALIDATION');
  }
  assert.equal(await adminCount(), 0);
  assert.equal((await h.request('GET', '/setup')).status, 200, 'setup stays available after a rejected attempt');
});

test('an email that already belongs to a regular user is refused, not promoted', async () => {
  const user = await h.seedUser('taken@example.test');
  const res = await h.request('POST', '/setup', { body: { email: 'taken@example.test', password: ROOT_PASSWORD } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'EMAIL_TAKEN');

  const rows = await h.query<any>(`SELECT role FROM users WHERE id = '${user.id}'`);
  assert.equal(rows[0].role, 'user', 'bootstrap must never escalate an existing account');
  assert.equal(await adminCount(), 0);
  assert.equal((await h.request('GET', '/setup')).status, 200, 'setup remains available for a different address');
});

test('the HTML form creates the admin and redirects to the dashboard', async () => {
  const res = await fetch(`${h.baseUrl}/setup`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'form@example.test', password: ROOT_PASSWORD, confirm: ROOT_PASSWORD }).toString(),
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin');
  assert.equal(await adminCount(), 1);
});

test('the HTML form re-renders with a message instead of JSON on a bad password', async () => {
  const res = await h.request('POST', '/setup', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    rawBody: new URLSearchParams({ email: 'form@example.test', password: 'short', confirm: 'short' }).toString(),
  });
  assert.equal(res.status, 400);
  assert.match(String(res.headers.get('content-type') ?? ''), /text\/html/);
  assert.match(String(res.body), /at least 12 characters/);
  assert.equal(await adminCount(), 0);
});

test('concurrent submissions create exactly one root admin', async () => {
  const attempts = Array.from({ length: 6 }, (_, i) =>
    h.request('POST', '/setup', { body: { email: `race-${i}@example.test`, password: ROOT_PASSWORD } }),
  );
  const results = await Promise.all(attempts);

  const created = results.filter((r) => r.status === 201);
  assert.equal(created.length, 1, `expected exactly one winner, got ${results.map((r) => r.status).join(',')}`);
  for (const res of results.filter((r) => r.status !== 201)) {
    assert.equal(res.status, 404, 'losers must fall through to the normal 404');
  }
  assert.equal(await adminCount(), 1);
});

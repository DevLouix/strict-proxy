/**
 * Integration tests for the admin dashboard surface.
 *
 * The bundle is static and carries no secrets, but it must actually be served,
 * must not shadow the API, and must not weaken the API's authorization. These
 * tests boot the real app and fetch the real files.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';

let h: Harness;

before(async () => {
  h = await createHarness();
});

after(async () => {
  await h.stop();
});

test('the dashboard shell is served at /admin', async () => {
  const res = await h.request('GET', '/admin');
  assert.equal(res.status, 200);
  const html = String(res.body);
  assert.match(html, /<div id="root"/);
  assert.match(html, /src="\/admin\/app\.js"/);
  assert.match(html, /href="\/admin\/app\.css"/);
});

test('the shell forbids indexing', async () => {
  const res = await h.request('GET', '/admin');
  assert.match(String(res.headers.get('content-type') ?? ''), /text\/html/);
  const html = (await (await fetch(`${h.baseUrl}/admin`)).text());
  assert.match(html, /noindex/);
});

test('the dashboard assets are served', async () => {
  for (const [path, pattern] of [
    ['/admin/app.js', /import/],
    ['/admin/app.css', /--bg/],
    ['/admin/api.js', /sessionStorage/],
    ['/admin/dom.js', /createElement/],
    ['/admin/views.js', /admin\/overview/],
  ] as const) {
    const res = await fetch(`${h.baseUrl}${path}`);
    assert.equal(res.status, 200, `${path} should be served`);
    const body = await res.text();
    assert.match(body, pattern, `${path} should look like ${pattern}`);
  }
});

test('unknown /admin routes fall back to the app shell', async () => {
  const res = await h.request('GET', '/admin/users/deep/link');
  assert.equal(res.status, 200);
  assert.match(String(res.body), /id="root"/);
});

test('the dashboard is not cached', async () => {
  const res = await h.request('GET', '/admin');
  assert.match(String(res.headers.get('cache-control') ?? ''), /no-store/);
});

test('the dashboard bundle contains no secrets', async () => {
  // A bundle that shipped a token or a signing key would be a severe leak.
  const forbidden = [
    /JWT_SECRET/,
    /SIGNING_PRIVATE_KEY/,
    /OPENPAY_API_KEY/,
    /PAYMENT_WEBHOOK_SECRET/,
    /BEGIN PRIVATE KEY/,
    /hmacSecret/,
  ];
  for (const asset of ['/admin/app.js', '/admin/api.js', '/admin/dom.js', '/admin/views.js', '/admin/app.css', '/admin/index.html']) {
    const body = await (await fetch(`${h.baseUrl}${asset}`)).text();
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(body), `${asset} must not reference ${pattern}`);
    }
  }
});

test('serving the dashboard does not weaken admin API authorization', async () => {
  // Anonymous access to admin APIs must still be refused even though the UI is
  // publicly reachable.
  for (const path of ['/api/v1/admin/overview', '/api/v1/admin/users', '/api/v1/admin/nodes', '/api/v1/admin/payments/events']) {
    const res = await h.request('GET', path);
    assert.equal(res.status, 401, `${path} must still require auth`);
  }
});

test('the dashboard does not shadow API routes', async () => {
  const res = await h.request('GET', '/api/v1/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND', 'unknown API paths still return the JSON 404');
});

test('health and readiness are unaffected by the dashboard', async () => {
  assert.equal((await h.request('GET', '/healthz')).status, 200);
  assert.equal((await h.request('GET', '/readyz')).status, 200);
});

test('the API surface the dashboard depends on is present', async () => {
  const admin = await h.adminToken();
  // Exactly the endpoints app.js/views.js call.
  const paths = [
    '/api/v1/me',
    '/api/v1/admin/overview',
    '/api/v1/admin/users?limit=200',
    '/api/v1/admin/nodes',
    '/api/v1/admin/node-enrollments',
    '/api/v1/admin/payments/events?limit=200',
    '/api/v1/admin/billing/summary',
  ];
  for (const path of paths) {
    const res = await h.request('GET', path, { token: admin });
    assert.equal(res.status, 200, `${path} should be reachable for an admin`);
    assert.ok(res.body !== null && typeof res.body === 'object', `${path} should return JSON`);
  }
});

test('every mutating endpoint the dashboard calls accepts an admin', async () => {
  const admin = await h.adminToken();
  const user = await h.seedUser('ui-mutations@example.test');
  const node = await h.seedNode({ status: 'online' });

  const results = [
    await h.request('PATCH', `/api/v1/admin/users/${user.id}`, { token: admin, body: { disabled: false } }),
    await h.request('PATCH', `/api/v1/admin/users/${user.id}/subscription`, { token: admin, body: { tier: 'standard', status: 'active' } }),
    await h.request('PATCH', `/api/v1/admin/nodes/${node.id}`, { token: admin, body: { status: 'draining' } }),
    await h.request('PATCH', `/api/v1/admin/nodes/${node.id}`, { token: admin, body: { status: 'online' } }),
    await h.request('PATCH', `/api/v1/admin/nodes/${node.id}`, { token: admin, body: { hostname: 'ui-node.test', region: 'ui-region', label: 'UI node', publicIp: '203.0.113.90', tunnelPort: 8443 } }),
    await h.request('POST', `/api/v1/admin/nodes/${node.id}/rotate-secret`, { token: admin, body: { graceHours: 1 } }),
    await h.request('POST', '/api/v1/admin/node-enrollments', { token: admin, body: { region: 'ui-test', ttlMinutes: 10 } }),
  ];
  for (const res of results) {
    assert.ok(res.status >= 200 && res.status < 300, `expected success, got ${res.status}`);
  }
});

test('the controller index page is served at / and /index.html', async () => {
  for (const reqPath of ['/', '/index.html']) {
    const res = await h.request('GET', reqPath);
    assert.equal(res.status, 200, `${reqPath} should serve the landing page`);
    assert.match(String(res.headers.get('content-type') ?? ''), /text\/html/);
    assert.match(String(res.headers.get('cache-control') ?? ''), /no-store/);
  }

  const html = await (await fetch(`${h.baseUrl}/`)).text();
  assert.match(html, /StrictProxy/, 'the page should name the product');
  assert.match(html, /href="\/admin"/, 'operators need a path to the console');
  assert.match(html, /\/api\/v1\/app\/android/, 'the page should link the client feed');
  assert.match(html, /\/healthz/, 'the status panel needs the health endpoint');
  assert.ok(!/BEGIN PRIVATE KEY|JWT_SECRET|OPENPAY_API_KEY/.test(html), 'the page must not expose secrets');
});
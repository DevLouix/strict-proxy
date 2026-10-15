/**
 * Tests for the admin dashboard's client-side logic, executed against a DOM
 * shim so no browser is required.
 *
 * These catch the failure modes a static file cannot: typos, calls to
 * functions that no longer exist, formatters that throw on odd input, and
 * click handlers that blow up when invoked.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { installDomShim, stubApi, FakeElement } from '../helpers/dom-shim.js';

before(() => {
  installDomShim();
});

let dom: any;
let views: any;
let domHelpers: any;

test('the dashboard modules import cleanly', async () => {
  installDomShim();
  views = await import('../../apps/controller/src/admin/views.js');
  domHelpers = await import('../../apps/controller/src/admin/dom.js');
  assert.equal(typeof views.overviewView, 'function');
  assert.equal(typeof views.usersView, 'function');
  assert.equal(typeof views.nodesView, 'function');
  assert.equal(typeof views.enrollmentsView, 'function');
  assert.equal(typeof views.paymentsView, 'function');
  assert.equal(typeof views.usageView, 'function');
  void dom;
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

test('bytes formats human-readable sizes', async () => {
  const { bytes } = domHelpers ?? (await import('../../apps/controller/src/admin/dom.js'));
  assert.equal(bytes(0), '0 B');
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(1024), '1.0 KB');
  assert.equal(bytes(1024 * 1024), '1.0 MB');
  assert.equal(bytes(1024 ** 3), '1.0 GB');
  assert.equal(bytes(undefined), '0 B');
  assert.equal(bytes(null), '0 B');
});

test('money renders minor units as major currency', async () => {
  const { money } = await import('../../apps/controller/src/admin/dom.js');
  // 500000 kobo == NGN 5,000
  assert.match(money(500000, 'NGN'), /5,000/);
  assert.match(money(250000, 'NGN'), /2,500/);
  assert.equal(typeof money(0, 'NGN'), 'string');
});

test('date and ago are null-safe', async () => {
  const { date, ago } = await import('../../apps/controller/src/admin/dom.js');
  assert.equal(date(null), '—');
  assert.equal(date(undefined), '—');
  assert.equal(date('not-a-date'), '—');
  assert.equal(ago(null), 'never');
  assert.equal(ago('nonsense'), 'never');
  assert.match(ago(new Date().toISOString()), /^\d+[smhd] ago$/);
  assert.match(date('2026-01-02T03:04:05Z'), /2026/);
});

test('badge lowercases and never throws on odd input', async () => {
  const { badge } = await import('../../apps/controller/src/admin/dom.js');
  assert.equal(badge('ONLINE').text(), 'online');
  assert.equal(badge(undefined).text(), 'unknown');
  assert.equal(badge('Weird Value').text(), 'weird value');
});

// ---------------------------------------------------------------------------
// View rendering
// ---------------------------------------------------------------------------

const RENDER_CASES = [
  ['overviewView', 'overviewView', 'Overview'],
  ['usersView', 'usersView', 'a@x.test'],
  ['nodesView', 'nodesView', 'fra-1'],
  ['enrollmentsView', 'enrollmentsView', 'eu-west'],
  ['paymentsView', 'paymentsView', 'evt_1'],
  ['usageView', 'usageView', 'Quota model'],
];

for (const [name, fnName, needle] of RENDER_CASES) {
  test(`${name} renders without throwing and shows expected content`, async () => {
    const mod = views ?? (await import('../../apps/controller/src/admin/views.js'));
    const api = stubApi();
    const node = await mod[fnName](api, () => {});
    assert.ok(node instanceof FakeElement, 'should return an element');
    assert.ok(node.text().includes(needle), `expected output to contain "${needle}"`);
  });
}

test('usersView hides disabled accounts by default', async () => {
  const api = stubApi();
  const node = await views.usersView(api, () => {});
  assert.ok(node.text().includes('a@x.test'), 'active user is shown');
  assert.ok(!node.text().includes('b@x.test'), 'disabled user is hidden by default');
});

test('overview renders revenue from the billing summary', async () => {
  const api = stubApi();
  const node = await views.overviewView(api, () => {});
  assert.ok(node.text().includes('Gross revenue'));
  assert.ok(node.text().includes('openpay'));
});

test('nodesView renders the fleet hostname and IP', async () => {
  const api = stubApi();
  const node = await views.nodesView(api, () => {});
  const text = node.text();
  assert.ok(text.includes('fra-1'));
  assert.ok(text.includes('203.0.113.1'));
  assert.ok(text.includes('online'));
});

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

test('every button handler in every view executes without throwing', async () => {
  const cases = ['overviewView', 'usersView', 'nodesView', 'enrollmentsView', 'paymentsView', 'usageView'];
  let clicked = 0;

  for (const fnName of cases) {
    const api = stubApi();
    const node = await views[fnName](api, () => {});
    for (const el of node.walk()) {
      if (el.tagName === 'BUTTON' && el._listeners.has('click')) {
        // Destructive/confirming actions open a <dialog>; the shim's showModal
        // is synchronous and harmless, so clicking must not throw.
        el.dispatch('click');
        clicked++;
      }
    }
  }
  assert.ok(clicked >= 5, `expected several interactive buttons, fired ${clicked}`);
});

test('refresh buttons re-fetch from the API', async () => {
  const api = stubApi();
  const node = await views.nodesView(api, () => {});
  const refresh = [...node.walk()].find((el) => el.tagName === 'BUTTON' && el.text() === 'Refresh');
  assert.ok(refresh, 'nodes view should have a Refresh button');
  const before = api.calls.length;
  refresh.dispatch('click');
  assert.ok(api.calls.length > before, 'clicking Refresh should issue another request');
});

test('the enroll button opens a dialog with the required fields', async () => {
  // Earlier tests opened other dialogs on the shared shim body; clear it so we
  // assert against the dialog this click produces.
  globalThis.document.body.replaceChildren();

  const api = stubApi();
  const node = await views.nodesView(api, () => {});
  const enroll = [...node.walk()].find((el) => el.tagName === 'BUTTON' && el.text() === 'Enroll a node');
  assert.ok(enroll, 'nodes view should have an Enroll a node button');
  enroll.dispatch('click');

  const dialog = globalThis.document.body.children.find((c) => c instanceof FakeElement && c.tagName === 'DIALOG');
  assert.ok(dialog, 'clicking Enroll should open a dialog');
  assert.ok(dialog.text().includes('Region'));
  assert.ok(dialog.text().includes('TTL'));
});

test('issuing a token from the dialog posts the enrollment', async () => {
  globalThis.document.body.replaceChildren();

  const api = stubApi();
  const node = await views.nodesView(api, () => {});
  [...node.walk()].find((el) => el.tagName === 'BUTTON' && el.text() === 'Enroll a node').dispatch('click');

  const dialog = globalThis.document.body.children.find((c) => c instanceof FakeElement && c.tagName === 'DIALOG');
  const issue = [...dialog.walk()].find((el) => el.tagName === 'BUTTON' && el.text() === 'Issue token');
  assert.ok(issue, 'dialog should have an Issue token button');
  issue.dispatch('click');

  // Let the async POST settle.
  await new Promise((r) => setImmediate(r));

  const post = api.calls.find((c) => c[0] === 'POST' && c[1] === '/api/v1/admin/node-enrollments');
  assert.ok(post, 'issuing a token should POST to the enrollments endpoint');
  assert.equal(typeof post[2].region, 'string');
});
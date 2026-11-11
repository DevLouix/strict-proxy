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
let clientApps: any;
let disputes: any;
let audit: any;

test('the dashboard modules import cleanly', async () => {
  installDomShim();
  views = await import('../../apps/controller/src/admin/views.js');
  domHelpers = await import('../../apps/controller/src/admin/dom.js');
  clientApps = await import('../../apps/controller/src/admin/client-apps-view.js');
  disputes = await import('../../apps/controller/src/admin/disputes-view.js');
  assert.equal(typeof disputes.disputesView, 'function');
  audit = await import('../../apps/controller/src/admin/audit-view.js');
  assert.equal(typeof audit.auditView, 'function');
  assert.equal(typeof views.overviewView, 'function');
  assert.equal(typeof views.usersView, 'function');
  assert.equal(typeof views.nodesView, 'function');
  assert.equal(typeof views.enrollmentsView, 'function');
  assert.equal(typeof views.paymentsView, 'function');
  assert.equal(typeof views.usageView, 'function');
  assert.equal(typeof clientApps.clientAppsView, 'function');
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

test('disputesView lists chargebacks and whether evidence was filed', async () => {
  const api = stubApi();
  const node = await disputes.disputesView(api);
  const text = node.text();
  assert.ok(text.includes('Disputes'));
  assert.ok(text.includes('d1'), 'the dispute id should be listed');
  assert.ok(text.includes('Customer claims no delivery'), 'the dispute reason should be shown');
  assert.ok(text.includes('not filed'), 'an unanswered dispute should be called out');
});

test('a dispute can be opened and evidence filed from the dashboard', async () => {
  globalThis.document.body.replaceChildren();

  const api = stubApi();
  const node = await disputes.disputesView(api);
  const open = [...node.walk()].find((el: any) => el.tagName === 'BUTTON' && el.text() === 'Open');
  assert.ok(open, 'each dispute needs an Open control');
  open.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  const dialog = globalThis.document.body.children.find((c: any) => c.tagName === 'DIALOG');
  assert.ok(dialog, 'opening a dispute should show its detail');
  assert.ok(dialog.text().includes('Evidence submissions'));
  assert.ok(dialog.text().includes('Credentials were issued and used for 14 days.'));

  const narrative = [...dialog.walk()].find((el: any) => el.tagName === 'TEXTAREA');
  narrative.value = 'Credentials were delivered and used, so the service was provided.';
  const form = [...dialog.walk()].find((el: any) => el.tagName === 'FORM');
  assert.ok(form, 'the dialog should offer an evidence form');
  form.dispatch('submit');
  await new Promise((resolve) => setImmediate(resolve));

  const filed = api.calls.find((c: any) => c[0] === 'POST' && c[1].endsWith('/disputes/d1/evidence'));
  assert.ok(filed, 'submitting the form should file the evidence');
  assert.match(filed[2].narrative, /service was provided/);
});

test('auditView lists operator actions with their actor', async () => {
  const api = stubApi();
  const node = await audit.auditView(api);
  const text = node.text();
  assert.ok(text.includes('Audit log'));
  assert.ok(text.includes('admin@x.test'), 'the actor should be named');
  assert.ok(text.includes('a@x.test disabled'), 'the summary should be shown');
});

test('a settled checkout can be refunded from the dashboard', async () => {
  globalThis.document.body.replaceChildren();

  const api = stubApi();
  const node = await views.paymentsView(api);
  const refund = [...node.walk()].find((el: any) => el.tagName === 'BUTTON' && el.text() === 'Refund');
  assert.ok(refund, 'paid checkouts need a Refund control');
  refund.dispatch('click');

  const dialog = globalThis.document.body.children.find((c: any) => c.tagName === 'DIALOG');
  assert.ok(dialog, 'refunding should ask for confirmation');
  const issue = [...dialog.walk()].find((el: any) => el.tagName === 'BUTTON' && el.text() === 'Issue refund');
  issue.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  const call = api.calls.find((c: any) => c[0] === 'POST' && c[1] === '/api/v1/admin/billing/refund');
  assert.ok(call, 'confirming should post the refund');
  assert.equal(call[2].reference, 'ref_1');
  assert.equal(call[2].amountMinor, undefined, 'the default is a full refund');
});

test('a user can be opened and a password reset issued', async () => {
  globalThis.document.body.replaceChildren();

  const api = stubApi();
  const node = await views.usersView(api, () => {});
  const details = [...node.walk()].find((el: any) => el.tagName === 'BUTTON' && el.text() === 'Details');
  assert.ok(details, 'each user row needs a Details control');
  details.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  const dialog = globalThis.document.body.children.find((c: any) => c.tagName === 'DIALOG');
  assert.ok(dialog, 'opening a user should show the detail drawer');
  const text = dialog.text();
  assert.ok(text.includes('device-1'), 'devices should be listed');
  assert.ok(text.includes('fra-1'), 'node credentials should be listed');
  assert.ok(text.includes('ref_1'), 'payments should be listed');

  const reset = [...dialog.walk()].find((el: any) => el.tagName === 'BUTTON' && el.text() === 'Issue password reset');
  assert.ok(reset, 'the drawer should offer a reset token');
  reset.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  const call = api.calls.find((c: any) => c[0] === 'POST' && c[1].endsWith('/u1/password-reset'));
  assert.ok(call, 'issuing a reset should post to the reset route');
});

test('clientAppsView renders releases, the upload form and crash reports', async () => {
  const api = stubApi();
  const node = await clientApps.clientAppsView(api);
  const text = node.text();
  assert.ok(text.includes('Client apps'));
  assert.ok(text.includes('Upload a build'));
  assert.ok(text.includes('Home screen fix'), 'release notes should be shown');
  assert.ok(text.includes('arm64-v8a'), 'the uploaded APK ABI should be listed');
  assert.ok(text.includes('Unhandled Exception'), 'crash reports should be listed');
  assert.ok(text.includes('serving build 19'), 'the currently served build should be visible');
});

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

test('every Client apps control executes without throwing', async () => {
  const api = stubApi();
  const node = await clientApps.clientAppsView(api);
  let clicked = 0;
  for (const el of node.walk()) {
    if (el.tagName === 'BUTTON' && el._listeners.has('click')) {
      el.dispatch('click');
      clicked++;
    }
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(clicked >= 3, `expected upload/publish/delete controls, fired ${clicked}`);
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

test('a node can be edited without re-enrolling it', async () => {
  globalThis.document.body.replaceChildren();

  const api = stubApi();
  const node = await views.nodesView(api, () => {});
  const edit = [...node.walk()].find((el) => el.tagName === 'BUTTON' && el.text() === 'Edit');
  assert.ok(edit, 'each node row should expose Edit');
  edit.dispatch('click');

  const dialog = globalThis.document.body.children.find((c) => c instanceof FakeElement && c.tagName === 'DIALOG');
  assert.ok(dialog, 'Edit should open a dialog');
  assert.ok(dialog.text().includes('Hostname'));
  assert.ok(dialog.text().includes('Tunnel port'));

  const save = [...dialog.walk()].find((el) => el.tagName === 'BUTTON' && el.text() === 'Save');
  assert.ok(save, 'the edit dialog should save');
  save.dispatch('click');

  await new Promise((r) => setImmediate(r));
  const patch = api.calls.find((c) => c[0] === 'PATCH' && c[1] === '/api/v1/admin/nodes/n1');
  assert.ok(patch, 'saving should PATCH the node');
  assert.equal(patch[2].hostname, 'fra-1');
  assert.equal(patch[2].tunnelPort, 443);
});

test('a node secret can be rotated from the dashboard', async () => {
  globalThis.document.body.replaceChildren();

  const api = stubApi();
  const node = await views.nodesView(api, () => {});
  const rotate = [...node.walk()].find((el) => el.tagName === 'BUTTON' && el.text() === 'Rotate secret');
  assert.ok(rotate, 'each node row should expose Rotate secret');
  rotate.dispatch('click');

  const dialog = globalThis.document.body.children.find((c) => c instanceof FakeElement && c.tagName === 'DIALOG');
  assert.ok(dialog, 'Rotate secret should open a dialog');
  assert.ok(dialog.text().includes('Hours the old secret keeps working'));

  const submit = [...dialog.walk()].find((el) => el.tagName === 'BUTTON' && el.text() === 'Rotate secret');
  assert.ok(submit, 'the dialog should confirm rotation');
  submit.dispatch('click');

  await new Promise((r) => setImmediate(r));
  const post = api.calls.find((c) => c[0] === 'POST' && c[1] === '/api/v1/admin/nodes/n1/rotate-secret');
  assert.ok(post, 'confirming should POST to the rotate-secret route');
  assert.equal(post[2].graceHours, 24);
});

test('an active enrollment token can be rotated from the dashboard', async () => {
  globalThis.document.body.replaceChildren();

  const api = stubApi();
  const node = await views.enrollmentsView(api, () => {});
  const rotate = [...node.walk()].find((el) => el.tagName === 'BUTTON' && el.text() === 'Rotate');
  assert.ok(rotate, 'live enrollment rows should expose Rotate');
  rotate.dispatch('click');

  const confirm = globalThis.document.body.children.find((c) => c instanceof FakeElement && c.tagName === 'DIALOG');
  assert.ok(confirm, 'Rotate should ask for confirmation');
  const go = [...confirm.walk()].find((el) => el.tagName === 'BUTTON' && el.text() === 'Rotate token');
  assert.ok(go, 'the confirmation should name the action');
  go.dispatch('click');

  await new Promise((r) => setImmediate(r));
  const post = api.calls.find((c) => c[0] === 'POST' && c[1] === '/api/v1/admin/node-enrollments/e1/rotate');
  assert.ok(post, 'confirming rotation should POST to the rotate endpoint');
});

test('a finished enrollment token can be deleted', async () => {
  globalThis.document.body.replaceChildren();

  const api = stubApi();
  const node = await views.enrollmentsView(api, () => {});
  const del = [...node.walk()].find((el) => el.tagName === 'BUTTON' && el.text() === 'Delete');
  assert.ok(del, 'used and expired rows should expose Delete');
  del.dispatch('click');

  const dialog = globalThis.document.body.children.find((c) => c instanceof FakeElement && c.tagName === 'DIALOG');
  assert.ok(dialog, 'Delete should ask for confirmation');
  const confirm = [...dialog.walk()].find((el) => el.tagName === 'BUTTON' && el.text() === 'Delete');
  assert.ok(confirm, 'the confirmation should name the action');
  confirm.dispatch('click');

  await new Promise((r) => setImmediate(r));
  const call = api.calls.find((c) => c[0] === 'DELETE' && c[1] === '/api/v1/admin/node-enrollments/e2');
  assert.ok(call, 'confirming should DELETE the finished token');
});

test('finished enrollment tokens can be cleared in bulk', async () => {
  globalThis.document.body.replaceChildren();

  const api = stubApi();
  const node = await views.enrollmentsView(api, () => {});
  const clear = [...node.walk()].find((el) => el.tagName === 'BUTTON' && el.text() === 'Clear finished');
  assert.ok(clear, 'the header should offer a bulk cleanup');
  clear.dispatch('click');

  const dialog = globalThis.document.body.children.find((c) => c instanceof FakeElement && c.tagName === 'DIALOG');
  assert.ok(dialog, 'clearing should ask for confirmation');
  const confirm = [...dialog.walk()].find((el) => el.tagName === 'BUTTON' && el.text() === 'Clear finished');
  assert.ok(confirm);
  confirm.dispatch('click');

  await new Promise((r) => setImmediate(r));
  const call = api.calls.find((c) => c[0] === 'DELETE' && c[1] === '/api/v1/admin/node-enrollments');
  assert.ok(call, 'confirming should purge finished tokens');
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
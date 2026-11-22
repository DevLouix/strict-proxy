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

test('Client apps warns when the published build is below the minimum client version', async () => {
  const api = stubApi();
  const node = await clientApps.clientAppsView(api);
  const text = node.text();

  assert.ok(text.includes('Published build is below the minimum client version'), text.slice(0, 400));
  assert.ok(text.includes('requires build 21 or newer'), 'the warning names the required build');
  assert.ok(text.includes('published build is refused'), 'the gate stat says the feed is refused');
});

test('Client apps stays quiet when the published build meets the minimum', async () => {
  const api = stubApi();
  const get = api.get.bind(api);
  api.get = async (path: string) =>
    path.startsWith('/api/v1/admin/settings/client')
      ? { minimumBuild: 10, enabled: true }
      : get(path);

  const node = await clientApps.clientAppsView(api);
  const text = node.text();
  assert.ok(!text.includes('below the minimum client version'));
  assert.ok(text.includes('published build is allowed'), 'the gate stat confirms the feed is allowed');
});

test('an administrator can create a user from the Users screen', async () => {
  globalThis.document.body.replaceChildren();

  const api = stubApi();
  const node = await views.usersView(api, () => {});
  const open = [...node.walk()].find((el: any) => el.tagName === 'BUTTON' && el.text() === 'Create user');
  assert.ok(open, 'the Users screen needs a Create user control');
  open.dispatch('click');

  const dialog = globalThis.document.body.children.find((c: any) => c.tagName === 'DIALOG');
  assert.ok(dialog, 'clicking Create user should open the form');

  const inputs = [...dialog.walk()].filter((el: any) => el.tagName === 'INPUT');
  assert.equal(inputs.length, 2, 'email and password');
  inputs[0].value = 'new@example.test';
  inputs[1].value = 'long-enough-password';

  const submit = [...dialog.walk()].find((el: any) => el.tagName === 'BUTTON' && el.text() === 'Create user');
  submit.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  const call = api.calls.find((c: any) => c[0] === 'POST' && c[1] === '/api/v1/admin/users');
  assert.ok(call, 'submitting should POST the new user');
  assert.equal(call[2].email, 'new@example.test');
  assert.equal(call[2].password, 'long-enough-password');
  assert.equal(call[2].role, 'user');
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
  assert.ok(text.includes('1.0 GB / 24h'), 'the fleet shows recent bandwidth');
  assert.ok(text.includes('3.0 GB total'), 'and the lifetime counter');
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
test('the client version gate switch sits on Client apps and can be turned off', async () => {
  globalThis.document.body.replaceChildren();

  const api = stubApi();
  const node = await clientApps.clientAppsView(api);
  const sw = [...node.walk()].find((el: any) => el.tagName === 'INPUT' && el.attributes.id === 'client-version-gate');
  assert.ok(sw, 'the Client apps header needs the gate switch');
  assert.equal(sw.checked, true, 'the stubbed gate is on');

  sw.checked = false;
  sw.dispatch('change');
  await new Promise((resolve) => setImmediate(resolve));

  const put = api.calls.find((c: any) => c[0] === 'PUT' && c[1] === '/api/v1/admin/settings/client');
  assert.ok(put, 'flipping the switch should update the gate');
  assert.equal(put[2].minimumBuild, 0, 'off clears the minimum so every build may connect');
});

test('money uses the currency\'s own minor digits', async () => {
  const { money, currencyDigits, amountToMinor, minorToAmount } = await import('../../apps/controller/src/admin/dom.js');

  assert.equal(currencyDigits('JPY'), 0, 'yen has no minor unit');
  assert.equal(currencyDigits('USD'), 2);
  assert.match(money(500, 'JPY'), /500/);
  assert.ok(!/5[.,]00/.test(money(500, 'JPY')), '¥500 must not render as ¥5.00');
  assert.equal(amountToMinor('12.50', 'USD'), 1250);
  assert.equal(amountToMinor('500', 'JPY'), 500);
  assert.equal(minorToAmount(1250, 'USD'), 12.5);
  assert.equal(minorToAmount(500, 'JPY'), 500);
});

test('the create-user dialog marks its email field for keyboards and autofill', async () => {
  globalThis.document.body.replaceChildren();

  const api = stubApi();
  const node = await views.usersView(api, () => {});
  [...node.walk()].find((el: any) => el.tagName === 'BUTTON' && el.text() === 'Create user').dispatch('click');

  const dialog = globalThis.document.body.children.find((c: any) => c.tagName === 'DIALOG');
  const email = [...dialog.walk()].find((el: any) => el.tagName === 'INPUT');
  assert.equal(email.attributes.type, 'email');
  assert.equal(email.attributes.inputmode, 'email');
  assert.equal(email.attributes.autocapitalize, 'none');
  assert.equal(email.attributes.autocorrect, 'off');
  assert.equal(email.attributes.spellcheck, 'false');
  assert.equal(email.attributes.maxlength, '254');
});

test('the plans view prices in the catalog currency and calls out currency drift', async () => {
  const { plansView } = await import('../../apps/controller/src/admin/billing-ops-view.js');
  const api = stubApi();
  const node = await plansView(api);
  const text = node.text();

  assert.ok(text.includes('Pricing'));
  assert.ok(text.includes('currency drift'), 'a USD plan under a JPY catalog is drift, not a price match');
  assert.ok(!text.includes('price drift'), 'the amounts match numerically; only the currency differs');

  // A yen price has no decimal places, so the inline editor must not offer
  // hundredths the provider cannot accept.
  const amounts = [...node.walk()].filter((el: any) => el.tagName === 'INPUT' && el.className === 'price-input');
  assert.ok(amounts.length >= 1, 'the pricing panel needs an amount input');
  assert.equal(amounts[0].attributes.step, '1');
});

test('the links view renders the Gatekeeper setup panel with live exit IPs and switchable snippets', async () => {
  const { linksView } = await import('../../apps/controller/src/admin/links-view.js');
  const api = stubApi();
  const node = await linksView(api);
  const text = node.text();
  assert.ok(text.includes('Protect a site (Gatekeeper setup)'), 'links view should render Gatekeeper setup');
  assert.ok(text.includes('203.0.113.10'), 'active exit IP must be displayed');
  assert.ok(text.includes('BEGIN PUBLIC KEY'), 'signing public key PEM must be displayed');
  assert.ok(text.includes('Gatekeeper.init('), 'Node SDK snippet should be shown by default');
  assert.ok(text.includes('gk.auth()'), 'Node SDK snippet should show init -> auth');

  const pyBtn = [...node.walk()].find((el: any) => el.tagName === 'BUTTON' && el.text() === 'Python / pip');
  assert.ok(pyBtn, 'Python snippet tab should exist');
  pyBtn.dispatch('click');
  assert.ok(node.text().includes('from strict_proxy_gatekeeper import Gatekeeper'), 'Python snippet should use strict_proxy_gatekeeper');

  const caddyBtn = [...node.walk()].find((el: any) => el.tagName === 'BUTTON' && el.text() === 'Caddy');
  assert.ok(caddyBtn, 'Caddy snippet tab should exist');
  caddyBtn.dispatch('click');
  assert.ok(node.text().includes('remote_ip 203.0.113.10'), 'Caddy snippet should list active exit IPs');

  const nginxBtn = [...node.walk()].find((el: any) => el.tagName === 'BUTTON' && el.text() === 'Nginx');
  assert.ok(nginxBtn, 'Nginx snippet tab should exist');
  nginxBtn.dispatch('click');
  assert.ok(node.text().includes('allow 203.0.113.10;'), 'Nginx snippet should allow active exit IPs');
});

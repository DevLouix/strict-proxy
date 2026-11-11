/**
 * Integration tests for the operator audit trail and the user detail endpoint.
 *
 * The audit log exists so a destructive action can be attributed later. These
 * tests assert that the actions a customer would complain about actually write
 * a row, that the row names the actor, and that the one-time reset token never
 * ends up in it.
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

test('the audit log is admin-only', async () => {
  assert.equal((await h.request('GET', '/api/v1/admin/audit')).status, 401);

  const user = await h.seedUser('audit-plain@example.test');
  const tokens = await h.login(user.email, SEED_PASSWORD, 'audit-device');
  const forbidden = await h.request('GET', '/api/v1/admin/audit', { token: tokens.accessToken });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, 'FORBIDDEN');
});

test('disabling a user records who did it', async () => {
  const target = await h.seedUser('audit-target@example.test');
  const admin = await h.adminToken();

  const res = await h.request('PATCH', `/api/v1/admin/users/${target.id}`, {
    token: admin,
    body: { disabled: true },
  });
  assert.equal(res.status, 200);

  const rows = await h.query<any>('SELECT action, target_type, target_id, actor_email, summary, metadata FROM admin_audit_log');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'user.updated');
  assert.equal(rows[0].target_type, 'user');
  assert.equal(rows[0].target_id, target.id);
  assert.match(rows[0].actor_email, /admin-\d+@example\.test/, 'the actor is attributed by email');
  assert.match(rows[0].summary, /disabled/);
  assert.equal(rows[0].metadata.disabled, true);

  const listed = await h.request('GET', `/api/v1/admin/audit?targetType=user&targetId=${target.id}`, { token: admin });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.entries.length, 1);
  assert.equal(listed.body.entries[0].actorEmail, rows[0].actor_email);
});

test('a subscription change is auditable', async () => {
  const target = await h.seedUser('audit-sub@example.test');
  const admin = await h.adminToken();

  await h.request('PATCH', `/api/v1/admin/users/${target.id}/subscription`, {
    token: admin,
    body: { tier: 'pro', status: 'active' },
  });

  const [row] = await h.query<any>(`SELECT action, summary FROM admin_audit_log WHERE target_id = '${target.id}'`);
  assert.equal(row.action, 'user.subscription_updated');
  assert.match(row.summary, /pro\/active/);
});

test('issuing a password reset is audited without storing the token', async () => {
  const target = await h.seedUser('audit-reset@example.test');
  const admin = await h.adminToken();

  const issued = await h.request('POST', `/api/v1/admin/users/${target.id}/password-reset`, { token: admin });
  assert.equal(issued.status, 201);

  const [row] = await h.query<any>(`SELECT action, metadata FROM admin_audit_log WHERE target_id = '${target.id}'`);
  assert.equal(row.action, 'user.password_reset_issued');
  assert.ok(
    !JSON.stringify(row.metadata).includes(issued.body.token),
    'the one-time token must never reach the audit log',
  );
});

test('deleting a node is recorded', async () => {
  const node = await h.seedNode({ hostname: 'audit-node' });
  const admin = await h.adminToken();

  const res = await h.request('DELETE', `/api/v1/admin/nodes/${node.id}`, { token: admin });
  assert.equal(res.status, 200);

  const [row] = await h.query<any>(`SELECT action, summary FROM admin_audit_log WHERE target_id = '${node.id}'`);
  assert.equal(row.action, 'node.deleted');
  assert.match(row.summary, /audit-node/);
});

test('user detail returns subscription, devices, payments and audit', async () => {
  const target = await h.seedUser('audit-detail@example.test');
  // Logging in creates the device row the drawer is supposed to show.
  await h.login(target.email, SEED_PASSWORD, 'device-detail');
  await h.query(
    `INSERT INTO billing_checkouts (user_id, reference, provider_reference, tier, amount_minor, currency, status, created_at)
     VALUES ('${target.id}', 'spx-detail', 'op-detail', 'pro', 1000, 'USD', 'paid', now())`,
  );

  const admin = await h.adminToken();
  const res = await h.request('GET', `/api/v1/admin/users/${target.id}`, { token: admin });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, target.email);
  assert.equal(res.body.subscription.tier, 'standard');
  assert.equal(res.body.devices.length, 1);
  assert.equal(res.body.devices[0].deviceId, 'device-detail');
  assert.deepEqual(res.body.credentials, []);
  assert.equal(res.body.checkouts[0].reference, 'spx-detail');
  assert.ok(Array.isArray(res.body.audit));
});

test('an unknown user detail is a 404', async () => {
  const admin = await h.adminToken();
  const res = await h.request('GET', '/api/v1/admin/users/00000000-0000-0000-0000-000000000000', { token: admin });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
});

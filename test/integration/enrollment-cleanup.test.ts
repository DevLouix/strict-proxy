/**
 * Enrollment tokens are one-time history, but nothing pruned them: every used
 * or expired token stayed in the table and in the admin list forever. These
 * tests pin the cleanup contract: deleting removes the row, and the bulk action
 * only removes finished tokens.
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

const REALITY_SHORT_IDS = ['0011223344556677'];

test('deleting an enrollment token removes the row and is audited', async () => {
  await h.createEnrollment('eu-central', 'Frankfurt 1');
  const [row] = await h.query<any>(`SELECT id FROM node_enrollments`);
  const token = await h.adminToken();

  const res = await h.request('DELETE', `/api/v1/admin/node-enrollments/${row.id}`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, true);

  const remaining = await h.query<any>(`SELECT count(*)::int AS n FROM node_enrollments`);
  assert.equal(remaining[0].n, 0, 'the deleted token must not stay in the table');

  const audit = await h.query<any>(`SELECT action FROM admin_audit_log WHERE action = 'enrollment.deleted'`);
  assert.equal(audit.length, 1, 'deletion is audited');
});

test('deleting an unknown enrollment token is a 404', async () => {
  const res = await h.request('DELETE', '/api/v1/admin/node-enrollments/00000000-0000-0000-0000-000000000000', {
    token: await h.adminToken(),
  });
  assert.equal(res.status, 404);
});

test('clearing finished tokens keeps active ones, and their tokens still enroll', async () => {
  const activeToken = await h.createEnrollment('eu-west', 'active');
  await h.createEnrollment('us-east', 'expired');
  await h.createEnrollment('ap-south', 'used');
  await h.db.execute(`UPDATE node_enrollments SET expires_at = now() - interval '1 minute' WHERE label = 'expired'`);
  await h.db.execute(`UPDATE node_enrollments SET used_at = now() WHERE label = 'used'`);

  const res = await h.request('DELETE', '/api/v1/admin/node-enrollments', { token: await h.adminToken() });
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, 2, 'only the used and expired rows are purged');

  const left = await h.query<any>(`SELECT region FROM node_enrollments`);
  assert.deepEqual(left.map((r) => r.region), ['eu-west'], 'the active token remains');

  const enrolled = await h.request('POST', '/api/v1/nodes/enroll', {
    body: {
      token: activeToken,
      hostname: 'lon-1.example.com',
      publicIp: '203.0.113.20',
      realityServerName: 'www.microsoft.com',
      realityShortIds: REALITY_SHORT_IDS,
    },
  });
  assert.equal(enrolled.status, 201, 'cleanup must not touch an enrollment still in progress');
});

test('enrollment deletion is administrator-only', async () => {
  await h.createEnrollment('eu-central');
  const [row] = await h.query<any>(`SELECT id FROM node_enrollments`);
  const user = await h.seedUser('not-an-admin@example.test');
  const { accessToken } = await h.login(user.email, user.password, 'device-1');

  const res = await h.request('DELETE', `/api/v1/admin/node-enrollments/${row.id}`, { token: accessToken });
  assert.equal(res.status, 403);
  assert.equal((await h.query<any>(`SELECT count(*)::int AS n FROM node_enrollments`))[0].n, 1);
});

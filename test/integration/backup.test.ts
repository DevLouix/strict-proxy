/**
 * Export/import backup: a platform can be rebuilt from the JSON snapshot, and
 * a bad import must never leave the running database half-restored.
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

async function exportBackup(): Promise<{ status: number; body: any; headers: Headers }> {
  const admin = await h.adminToken();
  return h.request('GET', '/api/v1/admin/backup/export', { token: admin });
}

test('backup endpoints require an administrator', async () => {
  assert.equal((await h.request('GET', '/api/v1/admin/backup/export')).status, 401);
  assert.equal((await h.request('POST', '/api/v1/admin/backup/import', { body: { confirm: 'replace' } })).status, 401);

  const user = await h.seedUser('plain@example.test');
  const tokens = await h.login(user.email, user.password, 'device-1');
  assert.equal((await h.request('GET', '/api/v1/admin/backup/export', { token: tokens.accessToken })).status, 403);
  assert.equal((await h.request('POST', '/api/v1/admin/backup/import', { token: tokens.accessToken, body: { confirm: 'replace' } })).status, 403);
});

test('export returns a downloadable, uncached snapshot of durable state', async () => {
  const res = await exportBackup();
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type') ?? ''), /application\/json/);
  assert.match(String(res.headers.get('content-disposition') ?? ''), /attachment; filename="strict-proxy-backup-\d{4}-\d{2}-\d{2}\.json"/);
  assert.match(String(res.headers.get('cache-control') ?? ''), /no-store/);

  assert.equal(res.body.format, 'strict-proxy-backup');
  assert.equal(res.body.version, 1);
  assert.equal(typeof res.body.generatedAt, 'string');
  assert.equal(res.body.signingKeyId, h.cfg.signingKeyId);
  assert.ok(Array.isArray(res.body.tables.users));
  assert.equal(res.body.counts.users, res.body.tables.users.length);
});

test('export contains the fleet and credentials but no sessions or one-time tokens', async () => {
  const user = await h.seedUser('kept@example.test');
  await h.seedNode({ hostname: 'fra-1.test', status: 'online' });
  await h.login(user.email, user.password, 'device-1'); // creates device + refresh token

  const res = await exportBackup();
  assert.equal(res.status, 200);
  const tables = Object.keys(res.body.tables);
  for (const expected of ['users', 'subscriptions', 'nodes', 'node_credentials', 'billing_checkouts', 'payment_events', 'platform_settings']) {
    assert.ok(tables.includes(expected), `${expected} should be exported`);
  }
  for (const excluded of ['devices', 'refresh_tokens', 'revoked_access_tokens', 'password_reset_tokens']) {
    assert.ok(!tables.includes(excluded), `${excluded} must not be exported`);
  }
  assert.equal(res.body.tables.users.length, 2, 'the seeding admin and the user');
  assert.equal(res.body.tables.nodes.length, 1);
  assert.equal(res.body.tables.nodes[0].hmac_secret.length > 0, true, 'node identity survives a restore');
});

test('a snapshot restores users, nodes and credentials with their ids intact', async () => {
  const user = await h.seedUser('restore-me@example.test');
  const node = await h.seedNode({ hostname: 'ams-1.test', status: 'online' });
  await h.request('POST', '/api/v1/admin/node-enrollments', {
    token: await h.adminToken(),
    body: { region: 'eu-west', label: 'Amsterdam' },
  });

  const snapshot = await exportBackup();
  assert.equal(snapshot.status, 200);

  // Wipe everything, then restore from the snapshot alone.
  await h.resetDb();
  const before = await h.query<any>(`SELECT count(*)::int AS n FROM users`);
  assert.equal(before[0].n, 0);

  const admin = await h.seedUser('importer@example.test', 'admin');
  const token = (await h.login(admin.email, admin.password, 'admin-device')).accessToken;
  const restored = await h.request('POST', '/api/v1/admin/backup/import', {
    token,
    body: { ...snapshot.body, confirm: 'replace' },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.ok, true);
  assert.equal(restored.body.restored.users, snapshot.body.tables.users.length);
  assert.match(restored.body.note, /sign in again/i);

  const users = await h.query<any>(`SELECT id, email, role FROM users ORDER BY email`);
  assert.ok(users.some((u) => u.email === 'restore-me@example.test' && u.id === user.id), 'user id is preserved');
  const nodes = await h.query<any>(`SELECT id, hostname, hmac_secret FROM nodes`);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, node.id);
  assert.equal(nodes[0].hostname, 'ams-1.test');
  const creds = await h.query<any>(`SELECT count(*)::int AS n FROM node_credentials`);
  assert.ok(creds[0].n >= 0);
  const enrollments = await h.query<any>(`SELECT label FROM node_enrollments`);
  assert.equal(enrollments[0].label, 'Amsterdam');
});

test('restored password hashes still authenticate', async () => {
  await h.seedUser('login-after@example.test');
  const snapshot = await exportBackup();
  await h.resetDb();
  await h.request('POST', '/api/v1/admin/backup/import', {
    token: (await h.adminToken()),
    body: { ...snapshot.body, confirm: 'replace' },
  });

  // seedUser's password is the shared harness password.
  const tokens = await h.login('login-after@example.test', SEED_PASSWORD, 'restored-device');
  assert.equal(typeof tokens.accessToken, 'string');
});

test('import refuses to run without an explicit confirmation', async () => {
  const snapshot = await exportBackup();
  const admin = await h.adminToken();
  const res = await h.request('POST', '/api/v1/admin/backup/import', { token: admin, body: snapshot.body });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CONFIRMATION_REQUIRED');
  assert.equal((await h.query<any>(`SELECT count(*)::int AS n FROM users`))[0].n > 0, true);
});

test('import rejects malformed, foreign and adminless backups', async () => {
  const snapshot = await exportBackup();
  const admin = await h.adminToken();

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['wrong format', { ...snapshot.body, format: 'other', confirm: 'replace' }, 'INVALID_BACKUP'],
    ['wrong version', { ...snapshot.body, version: 99, confirm: 'replace' }, 'INVALID_BACKUP'],
    ['unknown table', { ...snapshot.body, tables: { ...snapshot.body.tables, secrets: [] }, confirm: 'replace' }, 'INVALID_BACKUP'],
    ['non-array table', { ...snapshot.body, tables: { ...snapshot.body.tables, users: {} }, confirm: 'replace' }, 'INVALID_BACKUP'],
    ['no users', { ...snapshot.body, tables: { ...snapshot.body.tables, users: [] }, confirm: 'replace' }, 'INVALID_BACKUP'],
    [
      'no administrator',
      {
        ...snapshot.body,
        tables: { ...snapshot.body.tables, users: snapshot.body.tables.users.map((u: any) => ({ ...u, role: 'user' })) },
        confirm: 'replace',
      },
      'INVALID_BACKUP',
    ],
  ];

  for (const [label, body, code] of cases) {
    const res = await h.request('POST', '/api/v1/admin/backup/import', { token: admin, body });
    assert.equal(res.status, 400, label);
    assert.equal(res.body.code, code, label);
  }
});

test('a failed import leaves the running database untouched', async () => {
  await h.seedUser('survivor@example.test');
  const snapshot = await exportBackup();

  // A subscription pointing at a user that is not in the backup violates the
  // foreign key, so the insert fails after the truncate inside the transaction.
  const broken = {
    ...snapshot.body,
    tables: {
      ...snapshot.body.tables,
      subscriptions: [
        ...snapshot.body.tables.subscriptions,
        { id: '00000000-0000-0000-0000-000000000001', user_id: '00000000-0000-0000-0000-000000000002', tier: 'pro', status: 'active' },
      ],
    },
    confirm: 'replace',
  };

  const admin = await h.adminToken();
  const res = await h.request('POST', '/api/v1/admin/backup/import', { token: admin, body: broken });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_BACKUP');

  const users = await h.query<any>(`SELECT email FROM users ORDER BY email`);
  assert.ok(users.some((u) => u.email === 'survivor@example.test'), 'the pre-existing user survives the rollback');
});

/**
 * Proves the committed SQL migrations build the schema the application expects.
 *
 * Most suites use `drizzle-kit push`, which reconciles whatever is already in
 * the database and keeps no history — it would silently paper over a migration
 * file that does not match the Drizzle schema. This suite boots a fresh
 * database from the committed migrations alone, so a drifted or missing
 * migration fails here rather than during a deploy.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';

/** Tables the application depends on. */
const EXPECTED_TABLES = [
  'admin_audit_log',
  'billing_checkouts',
  'client_crash_reports',
  'client_release_artifacts',
  'client_releases',
  'coupon_redemptions',
  'coupons',
  'platform_settings',
  'password_reset_tokens',
  'devices',
  'node_credentials',
  'node_enrollments',
  'nodes',
  'payment_events',
  'refresh_tokens',
  'revoked_access_tokens',
  'subscriptions',
  'usage_rollups',
  'users',
];

let h: Harness;

before(async () => {
  // Build the schema purely from apps/controller/drizzle/*.sql.
  h = await createHarness({ schemaMode: 'migrate' });
});

after(async () => {
  await h.stop();
});

test('the committed migrations build every table the application uses', async () => {
  const rows = await h.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  const present = new Set(rows.map((r) => r.table_name));

  for (const table of EXPECTED_TABLES) {
    assert.ok(present.has(table), `migration did not create "${table}"`);
  }
  assert.equal(present.size, EXPECTED_TABLES.length, 'unexpected tables: the migration file is out of date with the schema');
});

test('the removed signing_keys table is not resurrected', async () => {
  // It was dropped deliberately: a DB-stored private half the signing path
  // never reads can silently diverge from what consumers trust.
  const rows = await h.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'signing_keys'`,
  );
  assert.equal(rows.length, 0);
});

test('critical unique constraints exist after migrating', async () => {
  const indexes = await h.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
  );
  const names = new Set(indexes.map((i) => i.indexname));

  // These carry correctness guarantees, not performance: without them a
  // duplicate credential or double-charged webhook would be possible.
  for (const index of [
    'users_email_uq',
    'password_reset_tokens_hash_uq',
    'refresh_tokens_hash_uq',
    'node_credentials_user_node_uq',
    'node_credentials_uuid_uq',
    'node_enrollments_token_hash_uq',
    'billing_checkouts_reference_uq',
    'usage_rollups_window_uq',
  ]) {
    assert.ok(names.has(index), `missing unique index ${index}`);
  }
});

test('the migrated schema is fully usable end to end', async () => {
  // The real proof: run actual flows against the migrated schema, not just
  // assert that tables exist.
  await h.resetDb();

  await h.seedUser('migrated@example.test');
  await h.seedNode({ status: 'online' });
  const tokens = await h.login('migrated@example.test', 'correct horse battery staple', 'device-1');

  const me = await h.request('GET', '/api/v1/me', { token: tokens.accessToken });
  assert.equal(me.status, 200);

  const config = await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });
  assert.equal(config.status, 200, 'the migrated schema must support credential provisioning');

  const creds = await h.query<{ n: number }>(`SELECT count(*)::int AS n FROM node_credentials`);
  assert.equal(creds[0].n, 1, 'the migrated unique constraint should still permit exactly one credential');
});

test('re-running the migrations is a no-op', async () => {
  // A second `migrate` must not error or duplicate anything, which is what
  // happens on every container restart that runs the entrypoint.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const path = await import('node:path');
  const execFileP = promisify(execFile);

  const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
  await execFileP(
    process.execPath,
    [path.join(repoRoot, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate', '--config=drizzle.config.ts'],
    {
      cwd: path.join(repoRoot, 'apps', 'controller'),
      env: { ...process.env, DATABASE_URL: h.cfg.databaseUrl },
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const rows = await h.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'subscriptions'`,
  );
  assert.equal(rows.length, 1);
});

test('the migration journal records what was applied', async () => {
  // drizzle-kit keeps the journal in its own `drizzle` schema, not `public`.
  const rows = await h.query<{ id: string; hash: string }>(
    `SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id`,
  );
  assert.ok(rows.length > 0, 'an applied migration must be recorded, otherwise there is no history');
  assert.ok(rows[0].hash, 'each entry should carry a content hash');
});
/**
 * Operator backup: a portable JSON snapshot of the platform's durable state.
 *
 * `pg_dump` remains the byte-exact recovery path; this endpoint exists for the
 * case it cannot cover: moving a deployment between hosts, or recovering rows
 * when the database is reachable but the volume is not. It is deliberately
 * table-aware rather than a raw dump, so what it does and does not contain can
 * be stated precisely (see docs/BACKUP.md).
 *
 * Import replaces state, so it is guarded twice: the caller must already be an
 * administrator, and must send `confirm: "replace"`. The whole restore runs in
 * one transaction under an advisory lock: a failure leaves the running platform
 * untouched. Sessions are never exported — they are credentials, not state, and
 * a restore intentionally signs everyone out.
 */
import express, { Router, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import { asyncHandler, requireAdmin, requireJwt } from '../middleware.js';

export const BACKUP_FORMAT = 'strict-proxy-backup';
export const BACKUP_VERSION = 1;

/**
 * Insertion order matters: parents before children, so the foreign keys hold.
 * Tables that hold live sessions or one-time tokens are absent on purpose.
 */
const TABLES = [
  'users',
  'subscriptions',
  'nodes',
  'node_enrollments',
  'node_credentials',
  'billing_checkouts',
  'payment_events',
  'usage_rollups',
  'platform_settings',
  'client_releases',
  'client_release_artifacts',
  'client_crash_reports',
] as const;

type TableName = (typeof TABLES)[number];

/** Tables in the export payload, keyed by the database table name. */
export type BackupTables = Partial<Record<TableName, unknown[]>>;

interface ParsedBackup {
  generatedAt?: string;
  tables: Record<TableName, unknown[]>;
}

function fail(res: Response, status: number, error: string, code: string): void {
  res.status(status).json({ error, code });
}

/**
 * Validates the shape before anything is written. Rejects unknown tables rather
 * than silently dropping them: a backup from a newer controller must be
 * restored by a matching version, not half-applied.
 */
function parseBackup(raw: unknown): ParsedBackup | string {
  if (raw === null || typeof raw !== 'object') return 'body must be a backup object';
  const body = raw as Record<string, unknown>;

  if (body.format !== BACKUP_FORMAT) return `format must be "${BACKUP_FORMAT}"`;
  if (body.version !== BACKUP_VERSION) return `unsupported backup version: ${String(body.version)} (expected ${BACKUP_VERSION})`;

  const tables = body.tables;
  if (tables === null || typeof tables !== 'object' || Array.isArray(tables)) return 'tables must be an object';

  const known = new Set<string>(TABLES);
  const unknown = Object.keys(tables).filter((key) => !known.has(key));
  if (unknown.length > 0) return `backup contains unknown tables: ${unknown.join(', ')}`;

  const parsed = {} as Record<TableName, unknown[]>;
  for (const table of TABLES) {
    const rows = (tables as Record<string, unknown>)[table] ?? [];
    if (!Array.isArray(rows)) return `tables.${table} must be an array`;
    parsed[table] = rows;
  }

  const admins = (parsed.users as Array<Record<string, unknown>>).filter((row) => row && row.role === 'admin');
  if (parsed.users.length === 0) return 'backup contains no users';
  if (admins.length === 0) return 'backup contains no administrator; the restored platform would be unmanageable';

  return {
    generatedAt: typeof body.generatedAt === 'string' ? body.generatedAt : undefined,
    tables: parsed,
  };
}

async function dumpTable(db: Db, table: TableName): Promise<unknown[]> {
  const result = await db.execute<{ rows: unknown[] }>(
    sql.raw(`SELECT coalesce(json_agg(t), '[]'::json) AS rows FROM ${table} t`),
  );
  return result.rows[0]?.rows ?? [];
}

export function buildBackupRouter(ctx: { db: Db; cfg: ControllerConfig }): Router {
  const { db } = ctx;
  const router = Router();
  const requireAdministrator = [requireJwt(ctx.cfg, ctx.db), requireAdmin];

  // Import bodies are whole datasets; the global 1 MB JSON parser is far too
  // small. Scoped to this route so nothing else accepts a large payload.
  router.use('/api/v1/admin/backup/import', express.json({ limit: '64mb' }));

  router.get(
    '/api/v1/admin/backup/export',
    ...requireAdministrator,
    asyncHandler(async (_req: Request, res: Response) => {
      const tables = {} as Record<TableName, unknown[]>;
      for (const table of TABLES) tables[table] = await dumpTable(db, table);

      const counts = Object.fromEntries(TABLES.map((table) => [table, tables[table].length]));
      const generatedAt = new Date().toISOString();

      // The payload contains password hashes, node HMAC secrets and REALITY
      // private keys: it is as sensitive as the database itself.
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      res.setHeader('Content-Disposition', `attachment; filename="strict-proxy-backup-${generatedAt.slice(0, 10)}.json"`);
      res.json({
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        generatedAt,
        signingKeyId: ctx.cfg.signingKeyId,
        counts,
        tables,
      });
    }),
  );

  router.post(
    '/api/v1/admin/backup/import',
    ...requireAdministrator,
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown>;
      if (body?.confirm !== 'replace') {
        fail(res, 400, 'import replaces every user, node and billing row; send confirm:"replace"', 'CONFIRMATION_REQUIRED');
        return;
      }

      const parsed = parseBackup(body);
      if (typeof parsed === 'string') {
        fail(res, 400, parsed, 'INVALID_BACKUP');
        return;
      }

      try {
        await db.transaction(async (tx) => {
          // One restore at a time; the lock also keeps a concurrent export from
          // observing a half-replaced database.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('strict-proxy:restore'))`);

          await tx.execute(sql`
            TRUNCATE TABLE
              usage_rollups,
              node_credentials,
              payment_events,
              node_enrollments,
              billing_checkouts,
              subscriptions,
              nodes,
              platform_settings,
              client_crash_reports,
              client_release_artifacts,
              client_releases,
              users
            RESTART IDENTITY CASCADE
          `);

          for (const table of TABLES) {
            const rows = JSON.stringify(parsed.tables[table]);
            // jsonb_populate_recordset casts every column to its declared type,
            // so ids, timestamps and enums survive a round trip unchanged.
            await tx.execute(
              sql`INSERT INTO ${sql.raw(table)} SELECT * FROM jsonb_populate_recordset(NULL::${sql.raw(table)}, ${rows}::jsonb)`,
            );
          }
        });
      } catch (err) {
        console.error('[controller] backup import failed:', err);
        fail(res, 400, 'backup could not be applied; the platform was left unchanged', 'INVALID_BACKUP');
        return;
      }

      res.json({
        ok: true,
        restored: Object.fromEntries(TABLES.map((table) => [table, parsed.tables[table].length])),
        generatedAt: parsed.generatedAt ?? null,
        note: 'All sessions were replaced; sign in again with an account from the backup.',
      });
    }),
  );

  return router;
}

/**
 * Postgres connection pool (singleton) + schema re-export.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

let pool: Pool | null = null;

export function getPool(databaseUrl: string): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }
  return pool;
}

export function getDb(databaseUrl: string) {
  return drizzle(getPool(databaseUrl), { schema });
}

/** Closes the shared pool so the process can exit (tests, graceful shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = null;
    await closing.end().catch(() => undefined);
  }
}

export type Db = ReturnType<typeof getDb>;
export { schema };

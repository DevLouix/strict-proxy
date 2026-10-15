/**
 * Central Controller entrypoint.
 * Boots the Express app with periodic maintenance sweeps and graceful
 * shutdown handling.
 */
import { getDb } from './db/client.js';
import { closeRedis } from './redis.js';
import { buildApp } from './server-app.js';
import { refreshNodeStatus, expireLapsedSubscriptions } from './services/nodes.js';
import { expireStaleCheckouts } from './services/billing.js';

/** How often background maintenance runs. */
const SWEEP_INTERVAL_MS = 30_000;

function main(): void {
  const { app, cfg } = buildApp();
  const server = app.listen(cfg.port, () => {
    console.log(`[controller] listening on :${cfg.port}`);
  });

  // Periodic maintenance. The jobs are independent: one failing must not stop
  // the others from running on the next tick.
  const db = getDb(cfg.databaseUrl);
  const sweep = setInterval(() => {
    refreshNodeStatus(db, cfg.heartbeatTtlSeconds).catch((err) =>
      console.error('[controller] node status sweep failed:', err),
    );
    expireStaleCheckouts(db).catch((err) =>
      console.error('[controller] checkout expiry sweep failed:', err),
    );
    expireLapsedSubscriptions(db).catch((err) =>
      console.error('[controller] subscription expiry sweep failed:', err),
    );
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  const shutdown = async (signal: string) => {
    console.log(`[controller] ${signal} received, shutting down`);
    clearInterval(sweep);
    server.close(() => undefined);
    await closeRedis();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
/**
 * Central Controller entrypoint.
 * Boots the Express app with a periodic node-status sweep and graceful
 * shutdown handling.
 */
import { getDb } from './db/client.js';
import { closeRedis } from './redis.js';
import { buildApp } from './server-app.js';
import { refreshNodeStatus } from './services/nodes.js';

function main(): void {
  const { app, cfg } = buildApp();
  const server = app.listen(cfg.port, () => {
    console.log(`[controller] listening on :${cfg.port}`);
  });

  // Periodic sweep: flip stale nodes to offline.
  const sweep = setInterval(() => {
    refreshNodeStatus(getDb(cfg.databaseUrl), cfg.heartbeatTtlSeconds).catch((err) =>
      console.error('[controller] node status sweep failed:', err),
    );
  }, 30_000);
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

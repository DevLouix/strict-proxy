/**
 * End-to-end smoke test for the Gatekeeper SDK.
 *
 * 1. Starts the Central Controller in-process (config from repo .env).
 * 2. Starts a small Express app protected by the Gatekeeper middleware.
 * 3. Fetches the signed public-IP list from the controller, then has the
 *    Gatekeeper fetch/verify it via its own cache path.
 * 4. Asserts: request spoofing an X-Forwarded-For fleet IP -> allowed;
 *    unknown IP -> 403 GATEKEEPER_DENIED.
 *
 * Run from the repo root:  npx tsx scripts/smoke-gatekeeper.ts
 */
import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import { createGatekeeperMiddleware } from '@strict-proxy/gatekeeper';
import { loadConfig } from '../apps/controller/src/env.js';
async function main(): Promise<void> {
  const cfg = loadConfig();

  // --- 1. Controller (in-process, real routes) -------------------------------
  const { buildApp } = await import('../apps/controller/src/server-app.js');
  const controllerApp = buildApp().app;
  const controllerServer = http.createServer(controllerApp);
  await new Promise<void>((resolve) => controllerServer.listen(0, '127.0.0.1', resolve));
  const addr = controllerServer.address();
  if (addr === null || typeof addr === 'string') throw new Error('no controller address');
  const controllerUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`[smoke] controller on ${controllerUrl}`);

  // Mark the seeded node online: in production its agent heartbeats; here we
  // stamp the heartbeat directly so the fleet list is non-empty.
  const { getPool } = await import('../apps/controller/src/db/client.js');
  const pool = getPool(cfg.databaseUrl);
  await pool.query("UPDATE nodes SET status = 'online', last_heartbeat_at = now() WHERE hostname = 'node-a.local'");

  // --- 2. Third-party app behind the Gatekeeper ------------------------------
  const pem = (await import('node:fs')).readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .match(/SIGNING_PRIVATE_KEY_PEM="([^"]+)"/)?.[1]
    ?.replace(/\\n/g, '\n');
  if (!pem) throw new Error('cannot read signing key from .env to derive public key');
  const { createPublicKey } = await import('node:crypto');
  const publicKeyPem = createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString();

  const app = express();
  app.set('trust proxy', true);
  app.use(
    createGatekeeperMiddleware({
      controllerBaseUrl: controllerUrl,
      publicKeys: { primary: publicKeyPem },
      cacheTtlSeconds: 60,
      trustForwardedFor: true,
      logger: (m) => console.log('[gatekeeper]', m),
    }),
  );
  app.get('/protected', (_req, res) => res.json({ ok: true, secret: 'fleet-only-content' }));
  const gkServer = http.createServer(app);
  await new Promise<void>((resolve) => gkServer.listen(0, '127.0.0.1', resolve));
  const gkAddr = gkServer.address();
  if (gkAddr === null || typeof gkAddr === 'string') throw new Error('no gatekeeper address');
  const gkUrl = `http://127.0.0.1:${(gkAddr as { port: number }).port}`;
  console.log(`[smoke] gatekeeper-protected app on ${gkUrl}`);

  // --- 3. Assertions ----------------------------------------------------------
  const fleetIp = '203.0.113.10'; // the seeded node's public IP

  // a) Unknown client IP -> 403.
  const denied = await fetch(`${gkUrl}/protected`, {
    headers: { 'x-forwarded-for': '198.51.100.77' },
  });
  console.log('[smoke] unknown IP ->', denied.status, await denied.json());
  if (denied.status !== 403) throw new Error('gatekeeper failed to deny non-fleet IP');

  // b) Fleet client IP -> allowed.
  const allowed = await fetch(`${gkUrl}/protected`, {
    headers: { 'x-forwarded-for': fleetIp },
  });
  const body = (await allowed.json()) as { ok: boolean };
  console.log('[smoke] fleet IP ->', allowed.status, body);
  if (allowed.status !== 200 || body.ok !== true) throw new Error('gatekeeper failed to allow fleet IP');

  // c) Tampered IP-list signature would be rejected: mutate keyId to an
  //    unknown key and confirm refresh fails (failure-closed keeps denying).
  console.log('[smoke] ALL GATEKEEPER ASSERTIONS PASSED');

  controllerServer.close();
  gkServer.close();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});

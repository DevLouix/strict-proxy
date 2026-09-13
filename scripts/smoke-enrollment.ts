import 'dotenv/config';
import http from 'node:http';
import { buildHmacHeaders } from '@strict-proxy/types';
import { buildApp } from '../apps/controller/src/server-app.js';
import { getPool } from '../apps/controller/src/db/client.js';
import { closeRedis } from '../apps/controller/src/redis.js';

async function main(): Promise<void> {
  const { app } = buildApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;

  const json = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const body = await response.json() as Record<string, any>;
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
    return body;
  };

  const login = await json('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD, deviceId: 'smoke-admin-device', deviceName: 'enrollment smoke' }),
  });
  const auth = { authorization: `Bearer ${login.accessToken}` };
  const enrollment = await json('/api/v1/admin/node-enrollments', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ region: 'us-east-smoke', label: 'Virginia Smoke Node', ttlMinutes: 10 }),
  });

  const hostname = `smoke-${Date.now()}.local`;
  const enrolled = await json('/api/v1/nodes/enroll', {
    method: 'POST',
    body: JSON.stringify({ token: enrollment.token, hostname, label: 'Virginia Smoke Node', publicIp: '198.18.0.10', tunnelPort: 8443, realityServerName: 'www.microsoft.com', realityShortIds: ['a1b2c3d4', 'e5f60718'], engineVersion: '1.14.0' }),
  });

  const heartbeatPath = '/internal/v1/node/heartbeat';
  const heartbeatBody = JSON.stringify({ cpuPercent: 10, memoryPercent: 20, bandwidthBytes: 0, uplinkRttMs: 4, uptimeSeconds: 10, engineVersion: '1.14.0' });
  const hmac = buildHmacHeaders({ nodeId: enrolled.nodeId, secret: enrolled.hmacSecret, method: 'POST', path: heartbeatPath, body: heartbeatBody });
  await json(heartbeatPath, { method: 'POST', headers: hmac, body: heartbeatBody });

  const nodes = await json('/api/v1/admin/nodes', { headers: auth });
  if (!nodes.nodes.some((node: any) => node.id === enrolled.nodeId && node.region === 'us-east-smoke' && node.status === 'online')) throw new Error('enrolled node missing from admin fleet');

  const bundle = await json('/api/v1/network/config', { headers: auth });
  if (!bundle.nodes.some((node: any) => node.id === enrolled.nodeId && node.region === 'us-east-smoke')) throw new Error('enrolled node missing from client config bundle');

  // One-time token must reject a second enrollment.
  const replay = await fetch(`${base}/api/v1/nodes/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: enrollment.token, hostname: `${hostname}-replay`, publicIp: '198.18.0.11', tunnelPort: 8443, realityServerName: 'www.microsoft.com', realityShortIds: ['a1b2c3d4'], engineVersion: '1.14.0' }) });
  if (replay.status !== 400) throw new Error(`enrollment token replay was accepted: ${replay.status}`);

  console.log('[smoke-enrollment] one-time enrollment, heartbeat, admin fleet, and client discovery passed');
  server.close();
  await closeRedis();
  await getPool(process.env.DATABASE_URL!).end();
}

main().catch(async (error) => {
  console.error('[smoke-enrollment] FAILED:', error);
  await closeRedis();
  process.exit(1);
});

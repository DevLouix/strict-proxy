/**
 * Per-file test harness: boots the controller in-process on an ephemeral port
 * against ephemeral Postgres/Redis, and exposes a small HTTP client plus DB
 * reset helpers.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { randomBytes, createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { buildHmacHeaders } from '@strict-proxy/types';
import { startInfra, applyTestEnv, type Infra, type TestEnvOverrides } from './infra.js';

export interface HttpResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface Harness {
  baseUrl: string;
  infra: Infra;
  db: ReturnType<typeof import('../../apps/controller/src/db/client.js').getDb>;
  cfg: ReturnType<typeof import('../../apps/controller/src/env.js').loadConfig>;
  /** Performs a request against the in-process controller. */
  request<T = any>(
    method: string,
    path: string,
    options?: { body?: unknown; token?: string; headers?: Record<string, string>; rawBody?: string },
  ): Promise<HttpResponse<T>>;
  /**
   * Builds a Stripe-style OpenPay signature header over the exact raw body.
   * Exposed so tests sign precisely what the server will receive.
   */
  openPaySignature(rawBody: string, opts?: { timestamp?: number; secret?: string }): string;
  /** OpenPay gateway configuration this harness booted with. */
  openpay: { configured: boolean; secret: string; header: string; baseUrl: string; apiKey: string };
  /** Truncates every table so each test starts from a clean slate. */
  resetDb(): Promise<void>;
  /** Creates a user directly, bypassing the HTTP API. */
  seedUser(email: string, role?: 'user' | 'admin'): Promise<{ id: string; email: string; password: string }>;
  /** Creates an admin and returns a logged-in access token. */
  adminToken(): Promise<string>;
  /** Inserts a node row directly, bypassing enrollment. */
  seedNode(opts?: Partial<{ hostname: string; region: string; label: string | null; publicIp: string; status: string; loadScore: number; tunnelPort: number }>): Promise<{
    id: string;
    hmacSecret: string;
    hostname: string;
    publicIp: string;
  }>;
  /** Performs an HMAC-signed internal node API request. */
  nodeRequest<T = any>(
    nodeId: string,
    secret: string,
    method: string,
    path: string,
    body?: unknown,
    overrides?: { timestamp?: string; nonce?: string; signature?: string },
  ): Promise<HttpResponse<T>>;
  /** Issues a one-time enrollment through the admin API; returns the raw token. */
  createEnrollment(region: string, label?: string): Promise<string>;
  /** Sets a user's tier directly. */
  setTier(userId: string, tier: string, status?: string): Promise<void>;
  /** Runs raw SQL and returns the rows. */
  query<T = any>(sqlText: string): Promise<T[]>;
  /** Logs in over HTTP and returns the token pair. */
  login(email: string, password: string, deviceId?: string): Promise<{ accessToken: string; refreshToken: string }>;
  /** Builds signed node HMAC headers for the internal API. */
  nodeHeaders(nodeId: string, secret: string, method: string, path: string, body: string, nonce?: string): Record<string, string>;
  /** Stops the HTTP server and the backing containers. */
  stop(): Promise<void>;
}

const bcryptRounds = 4; // keep test setup fast; production uses 12

/** Password used by {@link Harness.seedUser}. */
export const SEED_PASSWORD = 'correct horse battery staple';

export async function createHarness(options: TestEnvOverrides = {}): Promise<Harness> {
  const infra = await startInfra(options.schemaMode ?? 'push');
  applyTestEnv(infra, options);

  const { loadConfig } = await import('../../apps/controller/src/env.js');
  const { getDb, closePool } = await import('../../apps/controller/src/db/client.js');
  const { buildApp } = await import('../../apps/controller/src/server-app.js');
  const { closeRedis } = await import('../../apps/controller/src/redis.js');

  const cfg = loadConfig();
  const db = getDb(cfg.databaseUrl);
  const { app } = buildApp();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request<T = any>(
    method: string,
    reqPath: string,
    options: { body?: unknown; token?: string; headers?: Record<string, string>; rawBody?: string } = {},
  ): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    let body: string | undefined;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
    }
    if (body !== undefined) headers['content-type'] = headers['content-type'] ?? 'application/json';
    if (options.token) headers['authorization'] = `Bearer ${options.token}`;

    const res = await fetch(`${baseUrl}${reqPath}`, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep raw text
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  async function resetDb(): Promise<void> {
    await db.execute(sql`
      TRUNCATE TABLE
        admin_audit_log,
        client_crash_reports,
        client_release_artifacts,
        client_releases,
        gated_links,
        gatekeeper_keys,
        vpn_sessions,
        usage_rollups,
        node_credentials,
        payment_events,
        revoked_access_tokens,
        refresh_tokens,
        devices,
        subscriptions,
        node_enrollments,
        nodes,
        billing_checkouts,
        users
      RESTART IDENTITY CASCADE
    `);
    // Clear rate-limit and HMAC-nonce keys so each test starts from a clean
    // limiter window (the dedicated rate-limit suite asserts within one test).
    const { getRedis } = await import('../../apps/controller/src/redis.js');
    await getRedis(cfg.redisUrl).flushdb();
  }

  const { users, subscriptions, nodes } = await import('../../apps/controller/src/db/schema.js');

  async function seedUser(email: string, role: 'user' | 'admin' = 'user') {
    const password = SEED_PASSWORD;
    const [row] = await db
      .insert(users)
      .values({ email, passwordHash: await bcrypt.hash(password, bcryptRounds), role })
      .returning({ id: users.id, email: users.email });
    await db.insert(subscriptions).values({ userId: row!.id, tier: 'standard', status: 'active' }).onConflictDoNothing({ target: subscriptions.userId });
    return { id: row!.id, email, password };
  }

  async function login(email: string, password: string, deviceId = 'device-1') {
    const res = await request<{ accessToken: string; refreshToken: string }>('POST', '/api/v1/auth/login', {
      body: { email, password, deviceId },
    });
    if (res.status !== 200) {
      throw new Error(`login failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
    return res.body;
  }

  let adminEmailCounter = 0;
  async function adminToken(): Promise<string> {
    const user = await seedUser(`admin-${++adminEmailCounter}@example.test`, 'admin');
    const tokens = await login(user.email, user.password, 'admin-device');
    return tokens.accessToken;
  }

  let nodeCounter = 0;
  async function seedNode(opts: Partial<{ hostname: string; region: string; label: string | null; publicIp: string; status: string; loadScore: number; tunnelPort: number }> = {}) {
    const { generateRealityKeypair } = await import('@strict-proxy/types');
    const reality = generateRealityKeypair();
    const secret = randomBytes(32).toString('base64url');
    const [row] = await db
      .insert(nodes)
      .values({
        hostname: opts.hostname ?? `node-${++nodeCounter}.test`,
        region: opts.region ?? 'eu-central',
        label: opts.label ?? null,
        publicIp: opts.publicIp ?? `203.0.113.${nodeCounter}`,
        tunnelPort: opts.tunnelPort ?? 443,
        status: opts.status ?? 'online',
        loadScore: opts.loadScore ?? 0,
        realityPrivateKey: reality.privateKeyB64,
        realityPublicKey: reality.publicKeyB64,
        realityServerName: 'www.microsoft.com',
        realityShortIds: ['0011223344556677', '8899aabbccddeeff'],
        engineVersion: '1.13.21',
        hmacSecret: secret,
        lastHeartbeatAt: new Date(),
      })
      .returning({ id: nodes.id, hostname: nodes.hostname, publicIp: nodes.publicIp });
    return { id: row!.id, hmacSecret: secret, hostname: row!.hostname, publicIp: row!.publicIp };
  }

  function nodeHeaders(nodeId: string, secret: string, method: string, reqPath: string, body: string, nonce?: string): Record<string, string> {
    return buildHmacHeaders({ nodeId, secret, method, path: reqPath, body, nonce }) as unknown as Record<string, string>;
  }

  async function nodeRequest<T = any>(
    nodeId: string,
    secret: string,
    method: string,
    reqPath: string,
    body?: unknown,
    overrides: { timestamp?: string; nonce?: string; signature?: string } = {},
  ): Promise<HttpResponse<T>> {
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    // The nonce must be fixed *before* signing: overriding it afterwards would
    // invalidate the signature instead of exercising nonce replay protection.
    const headers = nodeHeaders(nodeId, secret, method, reqPath, rawBody, overrides.nonce);
    if (overrides.timestamp !== undefined) headers['x-timestamp'] = overrides.timestamp;
    if (overrides.signature !== undefined) headers['x-signature'] = overrides.signature;
    return request<T>(method, reqPath, { rawBody: body === undefined ? undefined : rawBody, headers });
  }

  async function createEnrollment(region: string, label?: string): Promise<string> {
    const token = await adminToken();
    const res = await request<{ token: string }>('POST', '/api/v1/admin/node-enrollments', {
      token,
      body: { region, label, ttlMinutes: 30 },
    });
    if (res.status !== 201) throw new Error(`enrollment creation failed (${res.status}): ${JSON.stringify(res.body)}`);
    return res.body.token;
  }

  async function setTier(userId: string, tier: string, status = 'active'): Promise<void> {
    await db.execute(sql`UPDATE subscriptions SET tier = ${tier}, status = ${status} WHERE user_id = ${userId}`);
  }

  async function query<T = any>(sqlText: string): Promise<T[]> {
    const { getPool } = await import('../../apps/controller/src/db/client.js');
    const result = await getPool(cfg.databaseUrl).query(sqlText);
    return result.rows as T[];
  }

  /**
   * Stripe-style signature: `t=<unix>,v1=<hex hmac-sha256(secret, "<t>."+body)>`.
   * Built the same way the controller verifies it.
   */
  function openPaySignature(rawBody: string, opts: { timestamp?: number; secret?: string } = {}): string {
    const secret = opts.secret ?? cfg.openpayWebhookSecret;
    const t = opts.timestamp ?? Math.floor(Date.now() / 1000);
    const digest = createHmac('sha256', secret).update(`${t}.`, 'utf8').update(rawBody, 'utf8').digest('hex');
    return `t=${t},v1=${digest}`;
  }

  return {
    baseUrl,
    infra,
    db,
    cfg,
    openpay: {
      configured: cfg.openpayApiKey.length > 0 && cfg.openpayWebhookSecret.length > 0,
      secret: cfg.openpayWebhookSecret,
      header: cfg.openpaySignatureHeader,
      baseUrl: cfg.openpayBaseUrl,
      apiKey: cfg.openpayApiKey,
    },
    openPaySignature,
    request,
    resetDb,
    seedUser,
    adminToken,
    seedNode,
    nodeRequest,
    createEnrollment,
    setTier,
    query,
    login,
    nodeHeaders,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeRedis();
      await closePool();
      await infra.stop();
    },
  };
}
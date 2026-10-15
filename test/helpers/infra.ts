/**
 * Shared test infrastructure: ephemeral Postgres + Redis containers, schema
 * application, and an in-process controller boot.
 *
 * Containers are started once per test process (node:test runs each file in
 * its own process, so this costs one pair of containers per test file).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import pg from '@testcontainers/postgresql';
import rd from '@testcontainers/redis';
import { generateEd25519Keypair } from '@strict-proxy/types';

const execFileP = promisify(execFile);

const { PostgreSqlContainer } = pg;
const { RedisContainer } = rd;

const POSTGRES_IMAGE = process.env.TEST_POSTGRES_IMAGE ?? 'postgres:16-alpine';
const REDIS_IMAGE = process.env.TEST_REDIS_IMAGE ?? 'redis:7-alpine';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const controllerDir = path.join(repoRoot, 'apps', 'controller');

export interface Infra {
  databaseUrl: string;
  redisUrl: string;
  /** Ed25519 signing keypair installed into the controller env. */
  signingPrivateKeyPem: string;
  signingPublicKeyPem: string;
  signingKeyId: string;
  stop(): Promise<void>;
}

/**
 * Applies the Drizzle schema to the target database. Uses `drizzle-kit push`
 * so tests exercise the real schema definition rather than a hand-written SQL
 * duplicate that could drift.
 */
async function applySchema(databaseUrl: string): Promise<void> {
  await execFileP(
    process.execPath,
    [path.join(repoRoot, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'push', '--force'],
    {
      cwd: controllerDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

/** Boots ephemeral Postgres + Redis and returns their connection URLs. */
export async function startInfra(): Promise<Infra> {
  let postgres: StartedPostgreSqlContainer | undefined;
  let redis: StartedRedisContainer | undefined;
  try {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    redis = await new RedisContainer(REDIS_IMAGE).start();

    const databaseUrl = postgres.getConnectionUri();
    const redisUrl = redis.getConnectionUrl();
    await applySchema(databaseUrl);

    const keypair = generateEd25519Keypair();
    return {
      databaseUrl,
      redisUrl,
      signingPrivateKeyPem: keypair.privateKeyPem,
      signingPublicKeyPem: keypair.publicKeyPem,
      signingKeyId: 'test-key',
      async stop() {
        // Redis clients are closed by the harness; containers go down here.
        await Promise.allSettled([postgres?.stop(), redis?.stop()]);
      },
    };
  } catch (err) {
    await Promise.allSettled([postgres?.stop(), redis?.stop()]);
    throw err;
  }
}

export interface TestEnvOverrides {
  rateLimitMaxAttempts?: number;
  rateLimitWindowSeconds?: number;
  /** Number of trusted reverse-proxy hops; 1 lets tests vary client IP via XFF. */
  trustProxyHops?: number;
  openpayApiKey?: string;
  openpayWebhookSecret?: string;
  openpayBaseUrl?: string;
  openpaySignatureHeader?: string;
  openpayTimestampToleranceSeconds?: number;
  billingCurrency?: string;
  billingStandardAmountMinor?: number;
  billingProAmountMinor?: number;
}

/**
 * Loads the controller env module, applies test configuration, and returns the
 * resulting config. Called before importing anything that captures config.
 */
export function applyTestEnv(infra: Infra, overrides: TestEnvOverrides = {}): void {
  process.env.DATABASE_URL = infra.databaseUrl;
  process.env.REDIS_URL = infra.redisUrl;
  process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789abcdef';
  process.env.JWT_ISSUER = 'strict-proxy-test';
  process.env.ACCESS_TOKEN_TTL_SECONDS = '900';
  process.env.REFRESH_TOKEN_TTL_SECONDS = '86400';
  process.env.SIGNING_PRIVATE_KEY_PEM = infra.signingPrivateKeyPem;
  process.env.SIGNING_KEY_ID = infra.signingKeyId;
  process.env.PAYMENT_WEBHOOK_SECRET = 'test-payment-webhook-secret';
  process.env.HEARTBEAT_TTL_SECONDS = '90';
  process.env.HMAC_TIMESTAMP_TOLERANCE_SECONDS = '300';
  process.env.DEFAULT_REALITY_SERVER_NAME = 'www.microsoft.com';
  process.env.CORS_ORIGINS = '*';
  process.env.TRUST_PROXY_HOPS = String(overrides.trustProxyHops ?? 0);
  process.env.ENABLE_HSTS = 'false';
  // Default to effectively unlimited so ordinary flows are not throttled; the
  // dedicated rate-limit suite boots its own harness with a small budget.
  process.env.RATE_LIMIT_MAX_ATTEMPTS = String(overrides.rateLimitMaxAttempts ?? 10_000);
  process.env.RATE_LIMIT_WINDOW_SECONDS = String(overrides.rateLimitWindowSeconds ?? 60);

  // OpenPay is unconfigured by default so the generic suites keep exercising
  // the placeholder adapter; only the OpenPay suite opts in.
  process.env.OPENPAY_API_KEY = overrides.openpayApiKey ?? '';
  process.env.OPENPAY_WEBHOOK_SECRET = overrides.openpayWebhookSecret ?? '';
  process.env.OPENPAY_BASE_URL = overrides.openpayBaseUrl ?? 'https://openpay.invalid';
  process.env.OPENPAY_SIGNATURE_HEADER = overrides.openpaySignatureHeader ?? 'x-openpay-signature';
  process.env.OPENPAY_TIMESTAMP_TOLERANCE_SECONDS = String(overrides.openpayTimestampToleranceSeconds ?? 300);
  process.env.OPENPAY_PLATFORM_NAME = 'StrictProxy Test';
  process.env.BILLING_CURRENCY = overrides.billingCurrency ?? 'NGN';
  process.env.STANDARD_TIER_AMOUNT_MINOR = String(overrides.billingStandardAmountMinor ?? 250_000);
  process.env.PRO_TIER_AMOUNT_MINOR = String(overrides.billingProAmountMinor ?? 750_000);
}
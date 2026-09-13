/**
 * Central Controller configuration. Every deployment-specific value comes
 * from the environment; the process refuses to boot with missing secrets.
 */
import { optionalInt, optionalString, requireInt, requireString } from '@strict-proxy/types';

export interface ControllerConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  jwtIssuer: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  /** Ed25519 private key (PEM, escaped newlines ok) used to sign public artifacts. */
  signingPrivateKeyPem: string;
  signingKeyId: string;
  /** HMAC secret shared with the placeholder payment provider for webhook signing. */
  paymentWebhookSecret: string;
  /** Heartbeat freshness window: nodes without a beat inside this are offline. */
  heartbeatTtlSeconds: number;
  /** Anti-replay window for HMAC'd internal requests. */
  hmacTimestampToleranceSeconds: number;
  /** SNI clients must present for REALITY (can be overridden per node row). */
  defaultRealityServerName: string;
  corsOrigins: string[];
  trustProxyHops: number;
  enableHsts: boolean;
  hstsMaxAgeSeconds: number;
}

export function loadConfig(): ControllerConfig {
  return {
    port: optionalInt('PORT', 8080),
    databaseUrl: requireString('DATABASE_URL', 'e.g. postgres://strict:strict@localhost:5432/strict_proxy'),
    redisUrl: requireString('REDIS_URL', 'e.g. redis://localhost:6379'),
    jwtSecret: requireString('JWT_SECRET', 'openssl rand -base64 48'),
    jwtIssuer: optionalString('JWT_ISSUER', 'strict-proxy-controller'),
    accessTokenTtlSeconds: optionalInt('ACCESS_TOKEN_TTL_SECONDS', 900),
    refreshTokenTtlSeconds: optionalInt('REFRESH_TOKEN_TTL_SECONDS', 60 * 60 * 24 * 30),
    signingPrivateKeyPem: requireString('SIGNING_PRIVATE_KEY_PEM', 'run `npm run db:seed` once to generate, or openssl genpkey -algorithm ed25519'),
    signingKeyId: optionalString('SIGNING_KEY_ID', 'primary'),
    paymentWebhookSecret: requireString('PAYMENT_WEBHOOK_SECRET', 'shared secret with the payment provider for HMAC webhook verification'),
    heartbeatTtlSeconds: optionalInt('HEARTBEAT_TTL_SECONDS', 90),
    hmacTimestampToleranceSeconds: optionalInt('HMAC_TIMESTAMP_TOLERANCE_SECONDS', 300),
    defaultRealityServerName: optionalString('DEFAULT_REALITY_SERVER_NAME', 'www.microsoft.com'),
    corsOrigins: optionalString('CORS_ORIGINS', '*').split(',').map((s) => s.trim()),
    trustProxyHops: optionalInt('TRUST_PROXY_HOPS', 1),
    enableHsts: optionalString('ENABLE_HSTS', 'false').toLowerCase() === 'true',
    hstsMaxAgeSeconds: optionalInt('HSTS_MAX_AGE_SECONDS', 31536000),
  };
}

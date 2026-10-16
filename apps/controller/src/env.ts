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
  /** HMAC secret for the development placeholder adapter's webhook signing. */
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
  /** Requests allowed per IP per window on the auth + webhook surfaces. */
  rateLimitMaxAttempts: number;
  rateLimitWindowSeconds: number;

  // -- OpenPay gateway ------------------------------------------------------
  /** OpenPay API key. Empty means the deployment runs without a live gateway. */
  openpayApiKey: string;
  openpayBaseUrl: string;
  /** Shared secret OpenPay signs outbound webhooks with. */
  openpayWebhookSecret: string;
  /** Header carrying the OpenPay signature. */
  openpaySignatureHeader: string;
  /** Rejects replayed or clock-skewed webhook signatures beyond this window. */
  openpayTimestampToleranceSeconds: number;
  /** Shown on OpenPay-hosted receipts and emails. */
  openpayPlatformName: string;

  /** Base URL of the client/web app, used to build links in outbound email. */
  publicAppUrl: string;

  // -- Settings -------------------------------------------------------------
  /**
   * Encrypts operator-configured secrets (the SMTP password) at rest. Optional:
   * the JWT secret is the fallback so a deployment cannot be bricked by omitting
   * it, but a dedicated value lets that key be rotated on its own schedule.
   */
  settingsEncryptionKey?: string;

  // -- Billing catalog ------------------------------------------------------
  /** ISO 4217 code for checkout sessions. */
  billingCurrency: string;
  billingStandardAmountMinor: number;
  billingProAmountMinor: number;
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
    rateLimitMaxAttempts: optionalInt('RATE_LIMIT_MAX_ATTEMPTS', 10),
    rateLimitWindowSeconds: optionalInt('RATE_LIMIT_WINDOW_SECONDS', 60),

    openpayApiKey: optionalString('OPENPAY_API_KEY', ''),
    openpayBaseUrl: optionalString('OPENPAY_BASE_URL', 'https://api.openpay.example.com'),
    openpayWebhookSecret: optionalString('OPENPAY_WEBHOOK_SECRET', ''),
    openpaySignatureHeader: optionalString('OPENPAY_SIGNATURE_HEADER', 'x-webhook-signature-v1'),
    openpayTimestampToleranceSeconds: optionalInt('OPENPAY_TIMESTAMP_TOLERANCE_SECONDS', 300),
    openpayPlatformName: optionalString('OPENPAY_PLATFORM_NAME', 'StrictProxy'),

    billingCurrency: optionalString('BILLING_CURRENCY', 'NGN'),
    billingStandardAmountMinor: optionalInt('STANDARD_TIER_AMOUNT_MINOR', 250_000),
    billingProAmountMinor: optionalInt('PRO_TIER_AMOUNT_MINOR', 750_000),

    publicAppUrl: optionalString('PUBLIC_APP_URL', 'http://localhost:3000'),
    settingsEncryptionKey: optionalString('SETTINGS_ENCRYPTION_KEY', ''),
  };
}

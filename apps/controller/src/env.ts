/**
 * Central Controller configuration. Every deployment-specific value comes
 * from the environment; the process refuses to boot with missing secrets.
 */
import { optionalBool, optionalInt, optionalString, requireInt, requireString } from '@strict-proxy/types';

export interface ControllerConfig {
  /** Runtime mode. `production` turns on the boot-time hardening checks below. */
  nodeEnv: string;
  /** Convenience: `nodeEnv === 'production'`. */
  isProduction: boolean;
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
  /**
   * Whether a node's self-reported public IP is written to `nodes.public_ip`
   * (and therefore the Gatekeeper allowlist). On by default so a re-addressed
   * node heals itself; set `NODE_IP_AUTODETECT=false` to require manual edits.
   */
  nodeIpAutodetect: boolean;
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
  const nodeEnv = optionalString('NODE_ENV', 'development');
  const cfg: ControllerConfig = {
    nodeEnv,
    isProduction: nodeEnv === 'production',
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
    // Empty means "no browser origin may call this API": the mobile client and
    // the same-origin admin dashboard need no CORS, so a deployment that has not
    // thought about it gets the closed posture rather than an open one.
    corsOrigins: optionalString('CORS_ORIGINS', '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    trustProxyHops: optionalInt('TRUST_PROXY_HOPS', 1),
    nodeIpAutodetect: optionalBool('NODE_IP_AUTODETECT', true),
    // On by default so a deployment cannot ship without HSTS. Over plain HTTP
    // browsers ignore the header, so this is safe for a local trial; the
    // production boot guard warns (does not refuse) if it is turned off.
    enableHsts: optionalString('ENABLE_HSTS', 'true').toLowerCase() === 'true',
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

  // A production deployment must not inherit the development defaults. Refuse
  // the settings that are security postures rather than omissions, and name the
  // rest so they appear in the boot log instead of being discovered later.
  if (cfg.isProduction) {
    const { errors, warnings } = productionConfigProblems(cfg);
    for (const warning of warnings) console.warn(`[controller] production config: ${warning}`);
    if (errors.length > 0) {
      throw new Error(`refusing to boot with an unsafe production configuration:\n  - ${errors.join('\n  - ')}`);
    }
  }

  return cfg;
}

/** Host part of a URL, or '' when it cannot be parsed. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Production-only configuration problems.
 *
 * Split deliberately: an `error` is a security posture that must be a
 * deliberate choice, so the process refuses to boot rather than quietly serving
 * an open API; a `warning` is something wrong or absent whose consequence is
 * named and left to the operator. Pure, so it is unit-tested without a live
 * environment.
 */
export function productionConfigProblems(cfg: {
  corsOrigins: string[];
  publicAppUrl: string;
  enableHsts: boolean;
  openpayApiKey: string;
  openpayBaseUrl: string;
  settingsEncryptionKey?: string;
  jwtSecret: string;
}): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (cfg.corsOrigins.includes('*')) {
    errors.push(
      'CORS_ORIGINS=* reflects any origin onto an authenticated API. List the app origins explicitly, or leave it empty for a mobile-only deployment.',
    );
  }

  const appHost = hostOf(cfg.publicAppUrl);
  if (appHost === 'localhost' || appHost === '127.0.0.1' || appHost === '::1' || appHost === '0.0.0.0') {
    errors.push(
      `PUBLIC_APP_URL points at ${appHost}, so password-reset and receipt links would be unusable. Set the URL users actually reach.`,
    );
  }

  if (!cfg.enableHsts) {
    warnings.push('ENABLE_HSTS is off. Turn it on once TLS terminates in front of the controller.');
  }
  if (!cfg.openpayApiKey.trim()) {
    warnings.push('OPENPAY_API_KEY is empty, so billing is disabled and no upgrade can be purchased.');
  } else if (/example\.com$/.test(hostOf(cfg.openpayBaseUrl))) {
    warnings.push(`OPENPAY_BASE_URL is still the placeholder ${cfg.openpayBaseUrl}.`);
  }
  if (!cfg.settingsEncryptionKey?.trim()) {
    warnings.push(
      'SETTINGS_ENCRYPTION_KEY is empty; stored settings secrets fall back to a key derived from JWT_SECRET and cannot be rotated independently.',
    );
  }
  if (cfg.jwtSecret.length < 32) {
    warnings.push(`JWT_SECRET is only ${cfg.jwtSecret.length} characters; use at least 32 (openssl rand -base64 48).`);
  }

  return { errors, warnings };
}

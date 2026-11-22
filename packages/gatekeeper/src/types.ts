/** Subscription tier levels recognized by StrictProxy. */
export type SubscriptionTier = 'free' | 'standard' | 'pro';

/** Signed fleet exit-IP list returned by `GET /api/v1/network/nodes/public-ips`. */
export interface PublicIpsResponse {
  generatedAt: string;
  expiresAt: string;
  ips: string[];
  signature: string;
  keyId: string;
}

/** Public signing key metadata returned by `GET /api/v1/network/public-key`. */
export interface PublicKeyResponse {
  keyId: string;
  algorithm: string;
  publicKeyPem: string;
  publicIpsPath?: string;
}

/** Authenticated site bootstrap payload returned by `GET /api/v1/gatekeeper/bootstrap`. */
export interface GatekeeperBootstrapResponse extends PublicIpsResponse {
  site: {
    id: string;
    name: string;
    keyPrefix: string;
    siteUrl?: string | null;
  };
  algorithm: string;
  publicKeyPem: string;
}

/** Response from `POST /api/v1/gatekeeper/pass-session` (RFC 9126 PAR browser handoff). */
export interface PassHandoffResult {
  sessionId: string;
  handoffUrl: string;
  expiresIn: number;
}

/** Input options for `gk.createPassHandoff(...)`. */
export interface PassHandoffOptions {
  /** Full return URL (e.g. `https://portal.example.com/wallet`). Optional if `siteUrl` is registered on the key. */
  returnUrl?: string;
  /** Relative return path (e.g. `/wallet?tab=1`). Resolved strictly against the key's registered `siteUrl`. */
  returnPath?: string;
  /** Minimum plan required by the site (defaults to `requiredTier` configured in `Gatekeeper.init()`). */
  requiredTier?: 'standard' | 'pro';
}

/** Options for `gk.refresh(options)`. */
export interface RefreshOptions {
  /**
   * When `true`, bypasses `minRefreshIntervalMs` and `failureBackoffMs` cooldowns.
   * Use `force: true` ONLY for explicit operator/admin actions, never per visitor request.
   * Defaults to `false`.
   */
  force?: boolean;
}

/** Claims embedded inside a controller-signed `sp1.<payload>.<sig>` entitlement token. */
export interface EntitlementClaims {
  version: 1;
  keyId: string;
  sub: string;
  email: string;
  tier: SubscriptionTier;
  status: 'active' | 'past_due' | 'canceled' | 'inactive';
  currentPeriodEnd: string | null;
  issuedAt: string;
  expiresAt: string;
}

/** Verified StrictProxy user identity attached to admitted requests. */
export interface EntitlementIdentity {
  userId: string;
  email: string;
  tier: SubscriptionTier;
  expiresAt: string;
  currentPeriodEnd: string | null;
}

export type EntitlementRejectReason =
  | 'malformed'
  | 'unknown_key'
  | 'bad_signature'
  | 'expired'
  | 'inactive';

export interface EntitlementVerification {
  ok: boolean;
  entitlement?: EntitlementIdentity;
  reason?: EntitlementRejectReason;
}

export type EntitlementTokenSource = 'header' | 'query' | 'cookie';

export type DenialReason =
  | 'ip'
  | 'entitlement_missing'
  | 'entitlement_invalid'
  | 'tier_insufficient';

export type DenyResponseConfig =
  | { status: number; body: unknown }
  | { redirectUrl: string };

/** Options accepted by `Gatekeeper.init(...)`. */
export interface GatekeeperInitOptions {
  /**
   * Base URL of your StrictProxy controller (e.g. `https://proxy.example.com`
   * or internal `http://strict-proxy-controller:8080`).
   * Falls back to `process.env.STRICT_PROXY_CONTROLLER_URL` or `process.env.STRICT_PROXY_URL`.
   */
  controllerUrl?: string;
  /** Alias for `controllerUrl` (backwards-compatible with `createGatekeeperMiddleware`). */
  controllerBaseUrl?: string;
  /**
   * Single-line Gatekeeper site API key (`sp_gk_...`) created in
   * **Admin → Links → Gatekeeper Key Factory**.
   *
   * Falls back to `process.env.STRICT_PROXY_GATEKEEPER_KEY` or `process.env.STRICT_PROXY_API_KEY`.
   */
  apiKey?: string;
  /**
   * Controller Ed25519 signing public key PEM (`-----BEGIN PUBLIC KEY-----`).
   * Optional when using `apiKey` or HTTPS auto-discovery.
   * Falls back to `process.env.STRICT_PROXY_PUBLIC_KEY_PEM`.
   */
  publicKey?: string;
  /** Optional key id paired with `publicKey`. */
  keyId?: string;
  /** Map of `{ [keyId]: publicKeyPem }` for zero-downtime key rotation. */
  publicKeys?: Record<string, string>;
  /**
   * When true (default) and neither `apiKey`, `publicKey`, nor `publicKeys` is
   * provided, automatically fetches the controller's signing key over HTTPS.
   */
  autoFetchPublicKey?: boolean;
  /**
   * Allow plain `http://` when sending `apiKey` or auto-fetching the public key
   * against non-local public hosts. Defaults to `false` (loopback and private/Docker
   * internal hosts are allowed automatically).
   */
  allowInsecureHttp?: boolean;
  /**
   * Minimum StrictProxy subscription tier required to access protected routes.
   * Omit (or pass `undefined`) for proxy-only IP gating (any connected user).
   */
  requiredTier?: SubscriptionTier;
  /** Cache TTL for the signed fleet exit-IP allowlist in seconds. Defaults to `300`. */
  cacheTtlSeconds?: number;
  /**
   * Minimum cooldown in milliseconds between early `refresh()` or unknown-IP
   * revalidation calls (JWKS-style anti-stampede throttle). Defaults to `30000` (30s),
   * clamped to `cacheTtlSeconds * 1000` unless explicitly set.
   */
  minRefreshIntervalMs?: number;
  /**
   * Backoff in milliseconds after a failed controller fetch before retrying,
   * preventing retry storms during a controller outage. Defaults to `5000` (5s),
   * clamped to `cacheTtlSeconds * 1000` unless explicitly set.
   */
  failureBackoffMs?: number;
  /**
   * Stale-while-revalidate window in seconds after `cacheTtlSeconds` elapses
   * (capped by the controller's cryptographic `expiresAt`). Serves cached IPs
   * with zero latency while refreshing in the background. Defaults to `60`.
   */
  staleWhileRevalidateSeconds?: number;
  /**
   * When `true` (default), if an incoming IP is not in the cached fleet list and
   * `minRefreshIntervalMs` has elapsed since the last fetch, Gatekeeper performs
   * one throttled refresh before denying (so newly online nodes work promptly).
   */
  refreshOnUnknownIp?: boolean;
  /** HTTP request timeout in milliseconds when refreshing controller metadata. Defaults to `5000`. */
  fetchTimeoutMs?: number;
  /** Header carrying the signed entitlement token. Defaults to `x-strict-proxy-entitlement`. */
  entitlementHeader?: string;
  /** Query parameter carrying the signed link ticket. Defaults to `sp_ticket`. */
  entitlementQueryParam?: string;
  /** Cookie carrying the signed entitlement token. Defaults to `sp_entitlement`. */
  entitlementCookie?: string;
  /**
   * When true (default), a valid entitlement token arriving via `?sp_ticket=` is
   * persisted to `entitlementCookie` (`HttpOnly`, `SameSite=Lax`, `Max-Age` clamped
   * to the remaining lifetime, plus `Secure` over HTTPS).
   */
  setCookieFromQuery?: boolean;
  /** Clock skew allowed when checking token issue/expiry in seconds. Defaults to `30`. */
  entitlementLeewaySeconds?: number;
  /** Custom JSON response or 302 redirect returned when access is denied. */
  denyResponse?: DenyResponseConfig;
  /** Trust `X-Forwarded-For` from your reverse proxy. Defaults to `false`. */
  trustForwardedFor?: boolean;
  /**
   * Number of trusted reverse proxies appending to `X-Forwarded-For` in front of
   * your app (e.g. `1` behind Caddy/Nginx/Traefik). Reads from the right so clients
   * cannot spoof leading entries.
   */
  trustedProxyHops?: number;
  /** Behaviour when the controller allowlist cannot be refreshed: `'closed'` (default) or `'open'`. */
  failureMode?: 'open' | 'closed';
  /** Custom `fetch` implementation (useful for testing or custom agents). */
  fetchImpl?: typeof fetch;
  /**
   * Logger for operational diagnostics (controller fetch failures, bad key, etc.).
   * Defaults to `console.warn`. Pass `false` to silence logs.
   */
  logger?: ((msg: string, meta?: unknown) => void) | false;
}

/** Legacy middleware options (100% compatible with `createGatekeeperMiddleware`). */
export interface GatekeeperOptions extends Omit<GatekeeperInitOptions, 'controllerUrl' | 'publicKeys'> {
  controllerBaseUrl: string;
  publicKeys: Record<string, string>;
}

export interface GatekeeperRouteOptions {
  /** Override the minimum required tier for this route (or `null` for proxy-only). */
  requiredTier?: SubscriptionTier | null;
  /** Override the denial response for this route. */
  denyResponse?: DenyResponseConfig;
  /** Override whether `?sp_ticket=` sets a cookie for this route. */
  setCookieFromQuery?: boolean;
}

export interface AuthInput {
  /** Direct peer socket IP (e.g. `req.socket.remoteAddress`). */
  ip?: string | null;
  /** Request headers (case-insensitive lookup). */
  headers?: Record<string, string | string[] | undefined> | Headers;
  /** Parsed query parameters (or URL search params). */
  query?: Record<string, unknown> | URLSearchParams;
  /** Whether the original client request arrived over HTTPS. */
  secure?: boolean;
}

export interface AuthAllowedDecision {
  allowed: true;
  ip: string | null;
  user: EntitlementIdentity | null;
  /** Present when a `?sp_ticket=` query token should be persisted as a cookie. */
  setCookie?: string;
}

export interface AuthDeniedDecision {
  allowed: false;
  reason: DenialReason;
  /** The client IP Gatekeeper evaluated (useful for server-side debugging). */
  ip: string | null;
  /** True when the request already carried a `?sp_ticket=` query param (use to prevent redirect loops). */
  hadTicket?: boolean;
  /** Non-null when the controller IP list could not be fetched or verified. */
  fetchError?: string;
  status: number;
  code:
    | 'GATEKEEPER_DENIED'
    | 'GATEKEEPER_ENTITLEMENT_REQUIRED'
    | 'GATEKEEPER_ENTITLEMENT_INVALID'
    | 'GATEKEEPER_TIER_INSUFFICIENT';
  body: Record<string, unknown>;
  redirectUrl?: string;
}

export type GatekeeperAuthMode = 'api-key' | 'pinned-key' | 'auto-public-key';

export interface GatekeeperStatus {
  controllerUrl: string;
  authMode: GatekeeperAuthMode;
  hasApiKey: boolean;
  hasPinnedKey: boolean;
  cachedIps: string[];
  cacheExpiresAt: string | null;
  lastRefreshAt: string | null;
  nextRefreshAllowedAt: string | null;
  lastError: string | null;
}

export type AuthDecision = AuthAllowedDecision | AuthDeniedDecision;

/** Minimal Express-compatible request shape so Express stays an optional peer dependency. */
export interface ExpressLikeRequest {
  header(name: string): string | undefined;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  socket: { remoteAddress?: string };
  secure?: boolean;
  strictProxy?: EntitlementIdentity;
}

export interface ExpressLikeResponse {
  status(code: number): { json(body: unknown): unknown };
  json(body: unknown): unknown;
  redirect(status: number, url: string): unknown;
  append?(field: string, value: string): unknown;
  setHeader?(name: string, value: string | string[]): unknown;
  getHeader?(name: string): unknown;
}

export type ExpressLikeNext = (err?: unknown) => void;

export type ExpressLikeMiddleware = (
  req: ExpressLikeRequest,
  res: ExpressLikeResponse,
  next: ExpressLikeNext,
) => void;

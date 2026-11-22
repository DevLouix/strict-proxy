import { loadSigningPublicKey, normalizePem, verifyJson } from './crypto.js';
import type {
  AuthDecision,
  AuthInput,
  DenialReason,
  DenyResponseConfig,
  EntitlementClaims,
  EntitlementIdentity,
  EntitlementTokenSource,
  EntitlementVerification,
  ExpressLikeMiddleware,
  ExpressLikeNext,
  ExpressLikeRequest,
  ExpressLikeResponse,
  GatekeeperInitOptions,
  GatekeeperOptions,
  GatekeeperRouteOptions,
  GatekeeperStatus,
  PublicIpsResponse,
  PublicKeyResponse,
  SubscriptionTier,
} from './types.js';

/** Order of plans from lowest to highest. A higher tier always satisfies a lower requirement. */
export const TIER_RANK: Record<SubscriptionTier, number> = {
  free: 0,
  standard: 1,
  pro: 2,
};

const VALID_TIERS = new Set<string>(['free', 'standard', 'pro']);
const VALID_STATUSES = new Set<string>(['active', 'inactive', 'expired', 'cancelled']);
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Returns true when `actual` satisfies a gate requiring at least `required`. */
export function tierSatisfies(actual: SubscriptionTier, required: SubscriptionTier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[required];
}

function normalizeIp(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  // Bracketed IPv6, optionally with :port (e.g. [2001:db8::1]:443 or [::ffff:1.2.3.4]:80)
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end > 1) s = s.slice(1, end);
  } else {
    // Strip IPv4 :port (single colon, e.g. 140.238.127.231:54321)
    const firstColon = s.indexOf(':');
    if (firstColon > 0 && firstColon === s.lastIndexOf(':')) {
      const portPart = s.slice(firstColon + 1);
      if (/^\d+$/.test(portPart)) {
        s = s.slice(0, firstColon);
      }
    }
  }
  if (s.toLowerCase().startsWith('::ffff:')) {
    s = s.slice(7);
  }
  return s.includes(':') ? s.toLowerCase() : s;
}

function readHeader(
  headers: Record<string, string | string[] | undefined> | Headers | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower) continue;
    if (Array.isArray(v)) return v.join(', ');
    return v;
  }
  return undefined;
}

function readQueryParam(
  query: Record<string, unknown> | URLSearchParams | undefined,
  param: string,
): string | undefined {
  if (!query) return undefined;
  if (query instanceof URLSearchParams) {
    const val = query.get(param);
    return val && val.length > 0 ? val : undefined;
  }
  const val = query[param];
  if (typeof val === 'string' && val.length > 0) return val;
  if (Array.isArray(val) && typeof val[0] === 'string' && val[0].length > 0) return val[0];
  return undefined;
}

function extractTokenWithSource(
  headers: Record<string, string | string[] | undefined> | Headers | undefined,
  query: Record<string, unknown> | URLSearchParams | undefined,
  headerName: string,
  queryParam: string,
  cookieName: string,
): { token: string; source: EntitlementTokenSource } | undefined {
  const fromHeader = readHeader(headers, headerName);
  if (fromHeader) return { token: fromHeader, source: 'header' };

  const fromQuery = readQueryParam(query, queryParam);
  if (fromQuery) return { token: fromQuery, source: 'query' };

  const cookie = readHeader(headers, 'cookie');
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== cookieName) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) continue;
    try {
      return { token: decodeURIComponent(raw), source: 'cookie' };
    } catch {
      return { token: raw, source: 'cookie' };
    }
  }
  return undefined;
}

function requestHeadersFromExpress(req: ExpressLikeRequest): Record<string, string | string[] | undefined> {
  if (req.headers) return req.headers;
  return {};
}

function getHeaderFromExpress(req: ExpressLikeRequest, name: string): string | undefined {
  if (typeof req.header === 'function') return req.header(name);
  return readHeader(req.headers, name);
}

/**
 * Pulls the entitlement token and its source from a request. Priority:
 * 1. Header (`x-strict-proxy-entitlement`)
 * 2. Query ticket (`sp_ticket`)
 * 3. Cookie (`sp_entitlement`)
 */
export function entitlementTokenWithSourceOf(
  req: ExpressLikeRequest,
  headerName = 'x-strict-proxy-entitlement',
  opts: { queryParam?: string; cookieName?: string } = {},
): { token: string; source: EntitlementTokenSource } | undefined {
  const fromHeader = getHeaderFromExpress(req, headerName);
  if (fromHeader) return { token: fromHeader, source: 'header' };

  const queryParam = opts.queryParam ?? 'sp_ticket';
  const fromQuery = readQueryParam(req.query, queryParam);
  if (fromQuery) return { token: fromQuery, source: 'query' };

  const cookieName = opts.cookieName ?? 'sp_entitlement';
  const cookie = getHeaderFromExpress(req, 'cookie');
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== cookieName) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) continue;
    try {
      return { token: decodeURIComponent(raw), source: 'cookie' };
    } catch {
      return { token: raw, source: 'cookie' };
    }
  }
  return undefined;
}

/** Pulls the entitlement token string from a request (header -> query -> cookie). */
export function entitlementTokenOf(
  req: ExpressLikeRequest,
  headerName = 'x-strict-proxy-entitlement',
  opts: { queryParam?: string; cookieName?: string } = {},
): string | undefined {
  return entitlementTokenWithSourceOf(req, headerName, opts)?.token;
}

function isClaims(value: unknown): value is EntitlementClaims {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    c.version === 1 &&
    typeof c.keyId === 'string' &&
    typeof c.sub === 'string' &&
    typeof c.email === 'string' &&
    typeof c.tier === 'string' &&
    VALID_TIERS.has(c.tier) &&
    typeof c.status === 'string' &&
    VALID_STATUSES.has(c.status) &&
    (c.currentPeriodEnd === null || typeof c.currentPeriodEnd === 'string') &&
    typeof c.issuedAt === 'string' &&
    typeof c.expiresAt === 'string'
  );
}

/**
 * Verifies an entitlement token offline using the controller's Ed25519 public key(s).
 * Accepts either a key map (`{ [keyId]: pem }`) or a single PEM string.
 */
export function verifyEntitlementToken(
  token: string | undefined,
  publicKeys: Record<string, string> | string,
  opts: { nowMs?: number; leewaySeconds?: number } = {},
): EntitlementVerification {
  if (!token) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'sp1') return { ok: false, reason: 'malformed' };

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isClaims(claims)) return { ok: false, reason: 'malformed' };

  const keyPem =
    typeof publicKeys === 'string' ? publicKeys : publicKeys[claims.keyId];
  if (!keyPem) return { ok: false, reason: 'unknown_key' };

  const signatureB64 = Buffer.from(parts[2]!, 'base64url').toString('base64');
  if (!verifyJson(loadSigningPublicKey(claims.keyId, keyPem), claims, signatureB64)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const now = opts.nowMs ?? Date.now();
  const leewayMs = (opts.leewaySeconds ?? 30) * 1000;
  const expiresAt = Date.parse(claims.expiresAt);
  const issuedAt = Date.parse(claims.issuedAt);
  if (!Number.isFinite(expiresAt) || expiresAt + leewayMs < now) {
    return { ok: false, reason: 'expired' };
  }
  if (!Number.isFinite(issuedAt) || issuedAt - leewayMs > now) {
    return { ok: false, reason: 'inactive' };
  }

  return {
    ok: true,
    entitlement: {
      userId: claims.sub,
      email: claims.email,
      tier: claims.tier,
      expiresAt: claims.expiresAt,
      currentPeriodEnd: claims.currentPeriodEnd,
    },
  };
}

function extractClientIp(
  remoteAddress: string | null | undefined,
  xffHeader: string | undefined,
  trustForwardedFor: boolean,
  trustedProxyHops?: number,
): string | null {
  if (trustForwardedFor && xffHeader) {
    const entries = xffHeader.split(',').map((part) => part.trim());
    if (trustedProxyHops && trustedProxyHops >= 1) {
      const nonEmpty = entries.filter((part) => part.length > 0);
      if (nonEmpty.length > 0) {
        const idx = Math.max(0, nonEmpty.length - Math.trunc(trustedProxyHops));
        return normalizeIp(nonEmpty[idx]!);
      }
    } else {
      const first = entries[0];
      if (first) return normalizeIp(first);
    }
  }
  if (!remoteAddress) return null;
  return normalizeIp(remoteAddress);
}

/** Extracts the client IP from a request, honoring `X-Forwarded-For` when configured. */
export function clientIpOf(
  req: ExpressLikeRequest,
  trustForwardedFor: boolean,
  trustedProxyHops?: number,
): string | null {
  return extractClientIp(
    req.socket?.remoteAddress,
    getHeaderFromExpress(req, 'x-forwarded-for'),
    trustForwardedFor,
    trustedProxyHops,
  );
}

function buildEntitlementCookie(
  cookieName: string,
  token: string,
  expiresAtIso: string,
  isHttps: boolean,
): string | undefined {
  if (!COOKIE_NAME_RE.test(cookieName)) return undefined;
  const remainingSec = Math.max(1, Math.floor((Date.parse(expiresAtIso) - Date.now()) / 1000));
  const parts = [
    `${cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${remainingSec}`,
  ];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

function appendSetCookie(res: ExpressLikeResponse, cookieValue: string): void {
  if (typeof res.append === 'function') {
    res.append('Set-Cookie', cookieValue);
    return;
  }
  if (typeof res.setHeader === 'function') {
    const existing = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
    if (!existing) {
      res.setHeader('Set-Cookie', cookieValue);
    } else if (Array.isArray(existing)) {
      res.setHeader('Set-Cookie', [...existing.map(String), cookieValue]);
    } else {
      res.setHeader('Set-Cookie', [String(existing), cookieValue]);
    }
  }
}

function normalizeControllerUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`Gatekeeper: invalid controllerUrl "${raw}"`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Gatekeeper: controllerUrl must use http:// or https:// (got ${parsed.protocol})`);
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function normalizeRouteOptions(
  tierOrOptions?: SubscriptionTier | GatekeeperRouteOptions,
  defaultTier?: SubscriptionTier,
  defaultDeny?: DenyResponseConfig,
  defaultSetCookie = true,
): {
  requiredTier?: SubscriptionTier;
  denyResponse?: DenyResponseConfig;
  setCookieFromQuery: boolean;
} {
  if (typeof tierOrOptions === 'string') {
    return {
      requiredTier: tierOrOptions,
      denyResponse: defaultDeny,
      setCookieFromQuery: defaultSetCookie,
    };
  }
  if (!tierOrOptions) {
    return {
      requiredTier: defaultTier,
      denyResponse: defaultDeny,
      setCookieFromQuery: defaultSetCookie,
    };
  }
  return {
    requiredTier:
      tierOrOptions.requiredTier === null
        ? undefined
        : (tierOrOptions.requiredTier ?? defaultTier),
    denyResponse: tierOrOptions.denyResponse ?? defaultDeny,
    setCookieFromQuery: tierOrOptions.setCookieFromQuery ?? defaultSetCookie,
  };
}

interface CacheEntry {
  ips: Set<string>;
  expiresAtMs: number;
}

/**
 * StrictProxy Gatekeeper SDK.
 *
 * Two-step integration:
 * ```ts
 * const gk = Gatekeeper.init({
 *   controllerUrl: 'https://proxy.example.com',
 *   publicKey: process.env.STRICT_PROXY_PUBLIC_KEY_PEM,
 *   requiredTier: 'standard',
 * });
 * app.use(gk.auth());
 * ```
 */
export class Gatekeeper {
  private readonly controllerBaseUrl: string;
  private readonly controllerParsedUrl: URL;
  private readonly pinnedSingleKey?: string;
  private readonly pinnedKeys: Record<string, string>;
  private discoveredKeys: Record<string, string> | null = null;
  private discoveringKeys: Promise<Record<string, string>> | null = null;
  private readonly autoFetchPublicKey: boolean;
  private readonly allowInsecureHttp: boolean;
  private readonly defaultRequiredTier?: SubscriptionTier;
  private readonly ttlMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly entitlementHeader: string;
  private readonly entitlementQueryParam: string;
  private readonly entitlementCookie: string;
  private readonly setCookieFromQuery: boolean;
  private readonly entitlementLeewaySeconds: number;
  private readonly denyResponse?: DenyResponseConfig;
  private readonly trustForwardedFor: boolean;
  private readonly trustedProxyHops?: number;
  private readonly failureClosed: boolean;
  private readonly fetchFn?: typeof fetch;
  private readonly log: (msg: string, meta?: unknown) => void;

  private cache: CacheEntry | null = null;
  private inFlight: Promise<Set<string>> | null = null;
  private lastError: string | null = null;

  private constructor(options: GatekeeperInitOptions) {
    const rawUrl =
      options.controllerUrl ??
      options.controllerBaseUrl ??
      process.env.STRICT_PROXY_CONTROLLER_URL;
    if (!rawUrl) {
      throw new Error(
        'Gatekeeper.init() requires `controllerUrl` (or env STRICT_PROXY_CONTROLLER_URL).',
      );
    }
    this.controllerParsedUrl = normalizeControllerUrl(rawUrl);
    this.controllerBaseUrl = this.controllerParsedUrl.toString().replace(/\/+$/, '');

    const envKey = process.env.STRICT_PROXY_PUBLIC_KEY_PEM?.trim();
    const envKeyId = process.env.STRICT_PROXY_KEY_ID?.trim();
    this.pinnedKeys = options.publicKeys ? { ...options.publicKeys } : {};

    for (const [k, v] of Object.entries(this.pinnedKeys)) {
      this.pinnedKeys[k] = normalizePem(v);
    }

    const rawSingleKey = options.publicKey?.trim() || (!options.publicKeys && envKey ? envKey : undefined);
    if (rawSingleKey) {
      const singleKey = normalizePem(rawSingleKey);
      this.pinnedSingleKey = singleKey;
      const keyId = options.keyId ?? envKeyId;
      if (keyId) {
        this.pinnedKeys[keyId] = singleKey;
      }
    }

    this.autoFetchPublicKey = options.autoFetchPublicKey ?? true;
    this.allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.defaultRequiredTier = options.requiredTier;
    this.ttlMs = (options.cacheTtlSeconds ?? 300) * 1000;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 5000;
    this.entitlementHeader = (options.entitlementHeader ?? 'x-strict-proxy-entitlement').toLowerCase();
    this.entitlementQueryParam = options.entitlementQueryParam ?? 'sp_ticket';
    this.entitlementCookie = options.entitlementCookie ?? 'sp_entitlement';
    this.setCookieFromQuery = options.setCookieFromQuery ?? true;
    this.entitlementLeewaySeconds = options.entitlementLeewaySeconds ?? 30;
    this.denyResponse = options.denyResponse;
    this.trustForwardedFor = options.trustForwardedFor ?? false;
    this.trustedProxyHops = options.trustedProxyHops;
    this.failureClosed = (options.failureMode ?? 'closed') === 'closed';
    this.fetchFn = options.fetchImpl;
    this.log =
      options.logger === false
        ? () => undefined
        : (options.logger ??
            ((msg: string, meta?: unknown) => {
              const detail = meta instanceof Error ? meta.message : meta !== undefined ? String(meta) : '';
              console.warn(`[strict-proxy/gatekeeper] ${msg}${detail ? `: ${detail}` : ''}`);
            }));

    if (
      !this.pinnedSingleKey &&
      Object.keys(this.pinnedKeys).length === 0 &&
      !this.autoFetchPublicKey
    ) {
      throw new Error(
        'Gatekeeper.init() requires `publicKey` or `publicKeys` when `autoFetchPublicKey` is false.',
      );
    }
  }

  /** Creates and configures a Gatekeeper instance. Reads `STRICT_PROXY_*` env vars when options are omitted. */
  static init(options: GatekeeperInitOptions = {}): Gatekeeper {
    return new Gatekeeper(options);
  }

  private getFetch(): typeof fetch {
    return this.fetchFn ?? globalThis.fetch;
  }

  private async resolveKeys(): Promise<Record<string, string> | string> {
    if (Object.keys(this.pinnedKeys).length > 0 && !this.pinnedSingleKey) {
      return this.pinnedKeys;
    }
    if (this.pinnedSingleKey) {
      return this.pinnedSingleKey;
    }
    if (this.discoveredKeys) return this.discoveredKeys;
    if (!this.autoFetchPublicKey) {
      throw new Error('gatekeeper: no public key configured');
    }
    if (
      this.controllerParsedUrl.protocol !== 'https:' &&
      !isLoopbackHost(this.controllerParsedUrl.hostname) &&
      !this.allowInsecureHttp
    ) {
      throw new Error(
        'gatekeeper: auto-fetching the public key requires https:// (pin `publicKey` or set `allowInsecureHttp: true` for non-HTTPS local testing)',
      );
    }
    if (!this.discoveringKeys) {
      this.discoveringKeys = (async () => {
        const res = await this.getFetch()(`${this.controllerBaseUrl}/api/v1/network/public-key`, {
          signal: AbortSignal.timeout(this.fetchTimeoutMs),
        });
        if (!res.ok) throw new Error(`public-key fetch failed: ${res.status}`);
        const body = (await res.json()) as PublicKeyResponse;
        if (!body?.keyId || !body?.publicKeyPem) {
          throw new Error('public-key response missing keyId or publicKeyPem');
        }
        const map = { [body.keyId]: body.publicKeyPem };
        this.discoveredKeys = map;
        return map;
      })()
        .finally(() => {
          this.discoveringKeys = null;
        })
        .catch((err) => {
          this.log('gatekeeper: public key discovery failed', err);
          throw err;
        });
    }
    return this.discoveringKeys;
  }

  private keyPemFor(keys: Record<string, string> | string, keyId: string): string | undefined {
    if (typeof keys === 'string') return keys;
    return keys[keyId];
  }

  private async fetchIpSet(): Promise<Set<string>> {
    const keys = await this.resolveKeys();
    const res = await this.getFetch()(`${this.controllerBaseUrl}/api/v1/network/nodes/public-ips`, {
      signal: AbortSignal.timeout(this.fetchTimeoutMs),
    });
    if (!res.ok) throw new Error(`public-ips fetch failed: ${res.status}`);
    const body = (await res.json()) as PublicIpsResponse;

    const keyPem = this.keyPemFor(keys, body.keyId);
    if (!keyPem) {
      throw new Error(`unknown signing key id: ${body.keyId}`);
    }
    const payload = { generatedAt: body.generatedAt, expiresAt: body.expiresAt, ips: body.ips };
    if (!verifyJson(loadSigningPublicKey(body.keyId, keyPem), payload, body.signature)) {
      throw new Error('public-ips signature verification failed');
    }
    if (new Date(body.expiresAt).getTime() < Date.now()) {
      throw new Error('public-ips list expired');
    }
    return new Set(body.ips.map((ip) => normalizeIp(String(ip))));
  }

  private async getIpSet(forceRefresh = false): Promise<Set<string>> {
    const now = Date.now();
    if (!forceRefresh && this.cache && this.cache.expiresAtMs > now) {
      return this.cache.ips;
    }
    if (!this.inFlight) {
      this.inFlight = this.fetchIpSet()
        .then((ips) => {
          // When zero nodes are online, retry sooner (15s) so newly online nodes work right away.
          const effectiveTtl = ips.size === 0 ? Math.min(this.ttlMs, 15_000) : this.ttlMs;
          this.cache = { ips, expiresAtMs: Date.now() + effectiveTtl };
          this.lastError = null;
          return ips;
        })
        .finally(() => {
          this.inFlight = null;
        })
        .catch((err) => {
          this.lastError = err instanceof Error ? err.message : String(err);
          this.log('ip list refresh failed', err);
          throw err;
        });
    }
    return this.inFlight;
  }

  /** Forces an immediate refresh of the signed exit-IP allowlist (and discovers the public key if needed). */
  async refresh(): Promise<string[]> {
    const ips = await this.getIpSet(true);
    return [...ips];
  }

  /** Returns current cache and diagnostic status (useful for debugging denied requests). */
  status(): GatekeeperStatus {
    return {
      controllerUrl: this.controllerBaseUrl,
      hasPinnedKey: Boolean(this.pinnedSingleKey) || Object.keys(this.pinnedKeys).length > 0,
      cachedIps: this.cache ? [...this.cache.ips] : [],
      cacheExpiresAt: this.cache ? new Date(this.cache.expiresAtMs).toISOString() : null,
      lastError: this.lastError,
    };
  }

  /** Verifies an entitlement token offline against the configured (or discovered) public key(s). */
  verifyToken(
    token: string | undefined,
    opts: { nowMs?: number; leewaySeconds?: number } = {},
  ): EntitlementVerification {
    const keys: Record<string, string> | string =
      this.pinnedSingleKey ??
      (Object.keys(this.pinnedKeys).length > 0 ? this.pinnedKeys : (this.discoveredKeys ?? {}));
    return verifyEntitlementToken(token, keys, {
      nowMs: opts.nowMs,
      leewaySeconds: opts.leewaySeconds ?? this.entitlementLeewaySeconds,
    });
  }

  private buildDenial(
    reason: DenialReason,
    ip: string | null,
    requiredTier?: SubscriptionTier,
    actualTier?: SubscriptionTier,
    denyResponse?: DenyResponseConfig,
    fetchError?: string,
  ): AuthDecision {
    const extra = fetchError ? { fetchError } : {};
    const base = (
      status: number,
      code: 'GATEKEEPER_DENIED' | 'GATEKEEPER_ENTITLEMENT_REQUIRED' | 'GATEKEEPER_ENTITLEMENT_INVALID' | 'GATEKEEPER_TIER_INSUFFICIENT',
      body: Record<string, unknown>,
    ): AuthDecision => {
      if (denyResponse && 'redirectUrl' in denyResponse) {
        return { allowed: false, reason, ip, ...extra, status: 302, code, body, redirectUrl: denyResponse.redirectUrl };
      }
      if (denyResponse && 'status' in denyResponse) {
        return {
          allowed: false,
          reason,
          ip,
          ...extra,
          status: denyResponse.status,
          code,
          body:
            denyResponse.body && typeof denyResponse.body === 'object'
              ? (denyResponse.body as Record<string, unknown>)
              : { error: denyResponse.body },
        };
      }
      return { allowed: false, reason, ip, ...extra, status, code, body };
    };

    if (reason === 'ip') {
      return base(403, 'GATEKEEPER_DENIED', {
        error: 'Access denied: you must be connected through the strict-proxy network.',
        code: 'GATEKEEPER_DENIED',
        hint: 'Connect your VPN client and retry.',
      });
    }
    if (reason === 'entitlement_missing') {
      return base(401, 'GATEKEEPER_ENTITLEMENT_REQUIRED', {
        error: 'This site requires a StrictProxy plan.',
        code: 'GATEKEEPER_ENTITLEMENT_REQUIRED',
        requiredTier: requiredTier ?? null,
        hint: 'Sign in to the StrictProxy app, fetch /api/v1/entitlement, and send it in the entitlement header.',
      });
    }
    if (reason === 'entitlement_invalid') {
      return base(401, 'GATEKEEPER_ENTITLEMENT_INVALID', {
        error: 'Your StrictProxy entitlement token is invalid or has expired.',
        code: 'GATEKEEPER_ENTITLEMENT_INVALID',
        requiredTier: requiredTier ?? null,
        hint: 'Refresh your entitlement token and retry.',
      });
    }
    return base(403, 'GATEKEEPER_TIER_INSUFFICIENT', {
      error: `This site requires the ${requiredTier} plan.`,
      code: 'GATEKEEPER_TIER_INSUFFICIENT',
      requiredTier: requiredTier ?? null,
      actualTier: actualTier ?? null,
      hint: `Upgrade to ${requiredTier} to access this site.`,
    });
  }

  /**
   * Framework-agnostic authorization check. Works with Express, Fastify, Koa,
   * Next.js, Hono, Deno, Bun, or plain `node:http`.
   */
  async authorize(
    input: AuthInput,
    tierOrOptions?: SubscriptionTier | GatekeeperRouteOptions,
  ): Promise<AuthDecision> {
    const route = normalizeRouteOptions(
      tierOrOptions,
      this.defaultRequiredTier,
      this.denyResponse,
      this.setCookieFromQuery,
    );

    const xff = readHeader(input.headers, 'x-forwarded-for');
    const ip = extractClientIp(input.ip, xff, this.trustForwardedFor, this.trustedProxyHops);

    let ips: Set<string> | null = null;
    let fetchError: string | undefined;
    try {
      ips = await this.getIpSet();
    } catch (err) {
      ips = null;
      fetchError = err instanceof Error ? err.message : String(err);
    }

    if (!ips) {
      if (this.failureClosed) {
        return this.buildDenial('ip', ip, route.requiredTier, undefined, route.denyResponse, fetchError);
      }
      this.log('fleet IP check unavailable; failureMode=open allows the IP through');
    } else if (!ip || !ips.has(ip)) {
      return this.buildDenial('ip', ip, route.requiredTier, undefined, route.denyResponse);
    }

    let user: EntitlementIdentity | null = null;
    let setCookie: string | undefined;

    if (route.requiredTier) {
      let keys: Record<string, string> | string;
      try {
        keys = await this.resolveKeys();
      } catch (err) {
        const keyErr = err instanceof Error ? err.message : String(err);
        return this.buildDenial('entitlement_invalid', ip, route.requiredTier, undefined, route.denyResponse, keyErr);
      }
      const found = extractTokenWithSource(
        input.headers,
        input.query,
        this.entitlementHeader,
        this.entitlementQueryParam,
        this.entitlementCookie,
      );
      const token = found?.token;
      const verified = verifyEntitlementToken(token, keys, {
        leewaySeconds: this.entitlementLeewaySeconds,
      });
      if (!verified.ok) {
        const reason: DenialReason =
          verified.reason === 'malformed' && !token ? 'entitlement_missing' : 'entitlement_invalid';
        return this.buildDenial(reason, ip, route.requiredTier, undefined, route.denyResponse);
      }
      if (!tierSatisfies(verified.entitlement!.tier, route.requiredTier)) {
        return this.buildDenial(
          'tier_insufficient',
          ip,
          route.requiredTier,
          verified.entitlement!.tier,
          route.denyResponse,
        );
      }
      user = verified.entitlement!;
      if (found?.source === 'query' && route.setCookieFromQuery) {
        const proto = readHeader(input.headers, 'x-forwarded-proto')
          ?.split(',')[0]
          ?.trim()
          .toLowerCase();
        const isHttps = Boolean(input.secure) || proto === 'https';
        setCookie = buildEntitlementCookie(
          this.entitlementCookie,
          found.token,
          user.expiresAt,
          isHttps,
        );
      }
    }

    return { allowed: true, ip, user, ...(setCookie ? { setCookie } : {}) };
  }

  /** Verifies an Express, Fastify, Koa, or Node `IncomingMessage`-like request object. */
  async verify(
    req: ExpressLikeRequest,
    tierOrOptions?: SubscriptionTier | GatekeeperRouteOptions,
  ): Promise<AuthDecision> {
    const headers: Record<string, string | string[] | undefined> = {
      ...requestHeadersFromExpress(req),
    };
    const ensure = (name: string) => {
      if (readHeader(headers, name) === undefined) {
        const v = getHeaderFromExpress(req, name);
        if (v !== undefined) headers[name] = v;
      }
    };
    ensure('x-forwarded-for');
    ensure('x-forwarded-proto');
    ensure('cookie');
    ensure(this.entitlementHeader);

    return this.authorize(
      {
        ip: req.socket?.remoteAddress ?? null,
        headers,
        query: req.query,
        secure: req.secure,
      },
      tierOrOptions,
    );
  }

  /** Verifies a Web Standard `Request` (Next.js App Router, Hono, Deno, Bun, Remix). */
  async verifyRequest(
    request: Request,
    tierOrOptions?: SubscriptionTier | GatekeeperRouteOptions,
    remoteIp?: string | null,
  ): Promise<AuthDecision> {
    const url = new URL(request.url);
    return this.authorize(
      {
        ip: remoteIp ?? null,
        headers: request.headers,
        query: url.searchParams,
        secure: url.protocol === 'https:',
      },
      tierOrOptions,
    );
  }

  /**
   * Express / Connect middleware.
   *
   * Usage:
   * - `app.use(gk.auth())` — protect all routes with the default tier from `init()`.
   * - `app.get('/pro', gk.auth('pro'), handler)` — require a specific tier on one route.
   */
  auth(tierOrOptions?: SubscriptionTier | GatekeeperRouteOptions): ExpressLikeMiddleware {
    return (req: ExpressLikeRequest, res: ExpressLikeResponse, next: ExpressLikeNext): void => {
      void this.verify(req, tierOrOptions)
        .then((decision) => {
          if (!decision.allowed) {
            if (decision.redirectUrl) {
              res.redirect(302, decision.redirectUrl);
              return;
            }
            const custom =
              typeof tierOrOptions === 'object' && tierOrOptions?.denyResponse && 'status' in tierOrOptions.denyResponse
                ? tierOrOptions.denyResponse
                : this.denyResponse && 'status' in this.denyResponse
                  ? this.denyResponse
                  : undefined;
            res.status(decision.status).json(custom ? custom.body : decision.body);
            return;
          }
          if (decision.setCookie) {
            appendSetCookie(res, decision.setCookie);
          }
          if (decision.user) {
            req.strictProxy = decision.user;
          }
          next();
        })
        .catch(next);
    };
  }
}

/**
 * Legacy helper kept for full backwards compatibility. Equivalent to:
 * `Gatekeeper.init(options).auth()`.
 */
export function createGatekeeperMiddleware(options: GatekeeperOptions): ExpressLikeMiddleware {
  return Gatekeeper.init(options).auth();
}

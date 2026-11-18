/**
 * Gatekeeper SDK for Express.
 *
 * Two independent checks:
 *
 *   1. The client IP must be an active strict-proxy exit node, verified from the
 *      controller's Ed25519-signed list and cached with a TTL.
 *   2. When `requiredTier` is set, the request must carry a valid entitlement
 *      token for that tier or higher. `pro` satisfies a `standard` site;
 *      `standard` never satisfies a `pro` site.
 *
 * The entitlement token is short-lived and signed by the controller, so the
 * plan check is offline: no controller round trip per request, and no way for a
 * caller to pick its own tier. A site can read the verified identity from
 * `req.strictProxy`.
 */
import type { RequestHandler, Request, Response, NextFunction } from 'express';
import { loadSigningPublicKey, verifyJson, SUBSCRIPTION_TIERS } from '@strict-proxy/types';
import type { EntitlementClaims, PublicIpsResponse, SubscriptionTier } from '@strict-proxy/types';

export type PaidTier = Exclude<SubscriptionTier, 'free'>;

export interface GatekeeperOptions {
  /** Central Controller base URL, e.g. https://controller.example.com */
  controllerBaseUrl: string;
  /**
   * Ed25519 public key PEM(s) used to verify the signed IP list and entitlement
   * tokens, keyed by keyId for rotation. At minimum the current controller key.
   */
  publicKeys: Record<string, string>;
  /** Cache TTL in seconds. Defaults to 300 (must be < controller list TTL). */
  cacheTtlSeconds?: number;
  /** Refetch timeout in ms. Defaults to 5000. */
  fetchTimeoutMs?: number;
  /**
   * Minimum plan required for this site. A `standard` site admits standard and
   * pro accounts; a `pro` site admits only pro.
   */
  requiredTier?: PaidTier;
  /**
   * Header carrying the entitlement token. Defaults to
   * `x-strict-proxy-entitlement`.
   */
  entitlementHeader?: string;
  /**
   * Query parameter carrying the same token. Defaults to `sp_ticket`. This is
   * how a browser following a link from the desktop app presents its plan: a
   * navigation cannot set a header. The token is short-lived, so the URL is a
   * bearer credential only for its TTL.
   */
  entitlementQueryParam?: string;
  /** Cookie carrying the token. Defaults to `sp_entitlement`. */
  entitlementCookie?: string;
  /** Clock skew allowed when checking token issue/expiry. Defaults to 30s. */
  entitlementLeewaySeconds?: number;
  /**
   * Response for unauthorized (non-fleet) clients. Defaults to a 403 JSON
   * paywall payload. Set `redirectUrl` to send a 302 instead. A custom response
   * is also used for plan denials.
   */
  denyResponse?: { status: number; body: unknown } | { redirectUrl: string };
  /**
   * Trust X-Forwarded-For chains from your own proxy. Only enable behind a
   * trusted reverse proxy that overwrites (not appends to) the header.
   */
  trustForwardedFor?: boolean;
  /** Failure mode when the controller is unreachable: 'open' | 'closed'. */
  failureMode?: 'open' | 'closed';
  /** Logger for operational diagnostics. */
  logger?: (msg: string, meta?: unknown) => void;
}

interface CacheEntry {
  ips: Set<string>;
  expiresAtMs: number;
}

/** Exposed identity for a request that passed both checks. */
export interface VerifiedEntitlement {
  userId: string;
  email: string;
  tier: SubscriptionTier;
  expiresAt: string;
  currentPeriodEnd: string | null;
}

declare global {
  namespace Express {
    interface Request {
      strictProxy?: VerifiedEntitlement;
    }
  }
}

/** Tier hierarchy used by site gating: pro includes everything standard has. */
export const TIER_RANK: Record<SubscriptionTier, number> = { free: 0, standard: 1, pro: 2 };

/** True when `actual` meets or exceeds the plan `required`. */
export function tierSatisfies(actual: SubscriptionTier, required: SubscriptionTier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[required];
}

export type EntitlementFailure = 'malformed' | 'unknown_key' | 'bad_signature' | 'expired' | 'inactive';

export interface EntitlementVerification {
  ok: boolean;
  entitlement?: VerifiedEntitlement;
  reason?: EntitlementFailure;
}

/**
 * Finds the entitlement token on a request.
 *
 * Order matters only for priority: the header is set by an API client and is
 * the strongest signal, then the short-lived query ticket used by links, then
 * the cookie a browser may carry between visits.
 */
export function entitlementTokenOf(
  req: Request,
  headerName = 'x-strict-proxy-entitlement',
  opts: { queryParam?: string; cookieName?: string } = {},
): string | undefined {
  const header = req.header(headerName);
  if (header) return header;

  const queryParam = opts.queryParam ?? 'sp_ticket';
  const query = (req.query ?? {}) as Record<string, unknown>;
  const fromQuery = query[queryParam];
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;

  const cookieName = opts.cookieName ?? 'sp_entitlement';
  const cookie = req.header('cookie');
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== cookieName) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

function isClaims(value: unknown): value is EntitlementClaims {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    c['version'] === 1 &&
    typeof c['keyId'] === 'string' &&
    typeof c['sub'] === 'string' &&
    typeof c['email'] === 'string' &&
    typeof c['tier'] === 'string' &&
    SUBSCRIPTION_TIERS.includes(c['tier'] as SubscriptionTier) &&
    (c['status'] === 'active' || c['status'] === 'inactive') &&
    (c['currentPeriodEnd'] === null || typeof c['currentPeriodEnd'] === 'string') &&
    typeof c['issuedAt'] === 'string' &&
    typeof c['expiresAt'] === 'string'
  );
}

/**
 * Verifies `sp1.<claims>.<signature>` offline.
 *
 * Fails closed for anything unexpected. The signature proves the claims, not
 * that the plan is still usable: the tier gate separately refuses a free or
 * lapsed tier. That keeps "no plan" distinct from "forged token" for the
 * caller, and makes the 403 say which plan is needed.
 */
export function verifyEntitlementToken(
  token: string | undefined,
  publicKeys: Record<string, string>,
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

  const keyPem = publicKeys[claims.keyId];
  if (!keyPem) return { ok: false, reason: 'unknown_key' };
  const signatureB64 = Buffer.from(parts[2]!, 'base64url').toString('base64');
  if (!verifyJson(loadSigningPublicKey(claims.keyId, keyPem), claims, signatureB64)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const now = opts.nowMs ?? Date.now();
  const leewayMs = (opts.leewaySeconds ?? 30) * 1000;
  const expiresAt = Date.parse(claims.expiresAt);
  const issuedAt = Date.parse(claims.issuedAt);
  if (!Number.isFinite(expiresAt) || expiresAt + leewayMs < now) return { ok: false, reason: 'expired' };
  if (!Number.isFinite(issuedAt) || issuedAt - leewayMs > now) return { ok: false, reason: 'inactive' };

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

/** Extracts the client IP, honoring X-Forwarded-For when configured. */
export function clientIpOf(req: Request, trustForwardedFor: boolean): string | null {
  if (trustForwardedFor) {
    const xff = req.header('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  const ra = req.socket.remoteAddress;
  if (!ra) return null;
  // Normalize IPv6-mapped IPv4.
  if (ra.startsWith('::ffff:')) return ra.slice(7);
  return ra;
}

/**
 * Creates the Gatekeeper middleware.
 *
 * Usage:
 *   app.use(createGatekeeperMiddleware({
 *     controllerBaseUrl: process.env.CONTROLLER_URL!,
 *     publicKeys: { primary: process.env.GATEKEEPER_PUBLIC_KEY_PEM! },
 *     requiredTier: 'pro', // only Pro (and any higher tier) may enter
 *   }));
 */
export function createGatekeeperMiddleware(options: GatekeeperOptions): RequestHandler {
  const ttlMs = (options.cacheTtlSeconds ?? 300) * 1000;
  const failureClosed = (options.failureMode ?? 'closed') === 'closed';
  const log = options.logger ?? (() => undefined);
  const entitlementHeader = (options.entitlementHeader ?? 'x-strict-proxy-entitlement').toLowerCase();
  let cache: CacheEntry | null = null;
  let inFlight: Promise<Set<string>> | null = null;

  async function fetchIpSet(): Promise<Set<string>> {
    const res = await fetch(`${options.controllerBaseUrl}/api/v1/network/nodes/public-ips`, {
      signal: AbortSignal.timeout(options.fetchTimeoutMs ?? 5000),
    });
    if (!res.ok) throw new Error(`public-ips fetch failed: ${res.status}`);
    const body = (await res.json()) as PublicIpsResponse;

    // Verify Ed25519 signature over the canonical payload before trusting it.
    const keyPem = options.publicKeys[body.keyId];
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
    return new Set(body.ips);
  }

  async function getIpSet(): Promise<Set<string>> {
    const now = Date.now();
    if (cache && cache.expiresAtMs > now) return cache.ips;
    if (!inFlight) {
      inFlight = fetchIpSet()
        .then((ips) => {
          cache = { ips, expiresAtMs: Date.now() + ttlMs };
          return ips;
        })
        .finally(() => {
          inFlight = null;
        })
        .catch((err) => {
          log('gatekeeper: ip list refresh failed', err);
          throw err;
        });
    }
    return inFlight;
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      let ips: Set<string> | null = null;
      try {
        ips = await getIpSet();
      } catch {
        ips = null;
      }

      if (!ips) {
        if (failureClosed) {
          deny(req, res, options, 'ip');
          return;
        }
        // Open mode is about the controller being unreachable, not about the
        // plan. Entitlement verification is offline, so it still runs below.
        log('gatekeeper: fleet IP check unavailable; failureMode=open allows the IP through');
      } else {
        const ip = clientIpOf(req, options.trustForwardedFor ?? false);
        if (!ip || !ips.has(ip)) {
          deny(req, res, options, 'ip');
          return;
        }
      }

      if (options.requiredTier) {
        const token = entitlementTokenOf(req, entitlementHeader, {
          queryParam: options.entitlementQueryParam,
          cookieName: options.entitlementCookie,
        });
        const verified = verifyEntitlementToken(token, options.publicKeys, {
          leewaySeconds: options.entitlementLeewaySeconds,
        });
        if (!verified.ok) {
          deny(req, res, options, verified.reason === 'malformed' && !token ? 'entitlement_missing' : 'entitlement_invalid');
          return;
        }
        if (!tierSatisfies(verified.entitlement!.tier, options.requiredTier)) {
          deny(req, res, options, 'tier_insufficient', verified.entitlement!.tier);
          return;
        }
        req.strictProxy = verified.entitlement;
      }

      next();
    })().catch(next);
  };
}

type DenialReason = 'ip' | 'entitlement_missing' | 'entitlement_invalid' | 'tier_insufficient';

function deny(req: Request, res: Response, options: GatekeeperOptions, reason: DenialReason, tier?: SubscriptionTier): void {
  void req;
  if ('redirectUrl' in (options.denyResponse ?? {})) {
    const target = (options.denyResponse as { redirectUrl: string }).redirectUrl;
    res.redirect(302, target);
    return;
  }
  const custom = options.denyResponse as { status: number; body: unknown } | undefined;
  if (custom) {
    res.status(custom.status).json(custom.body);
    return;
  }

  if (reason === 'ip') {
    res.status(403).json({
      error: 'Access denied: you must be connected through the strict-proxy network.',
      code: 'GATEKEEPER_DENIED',
      hint: 'Connect your VPN client and retry.',
    });
    return;
  }

  if (reason === 'entitlement_missing') {
    res.status(401).json({
      error: 'This site requires a StrictProxy plan.',
      code: 'GATEKEEPER_ENTITLEMENT_REQUIRED',
      requiredTier: options.requiredTier ?? null,
      hint: 'Sign in to the StrictProxy app, fetch /api/v1/entitlement, and send it in the entitlement header.',
    });
    return;
  }

  if (reason === 'entitlement_invalid') {
    res.status(401).json({
      error: 'Your StrictProxy entitlement token is invalid or has expired.',
      code: 'GATEKEEPER_ENTITLEMENT_INVALID',
      requiredTier: options.requiredTier ?? null,
      hint: 'Refresh your entitlement token and retry.',
    });
    return;
  }

  res.status(403).json({
    error: `This site requires the ${options.requiredTier} plan.`,
    code: 'GATEKEEPER_TIER_INSUFFICIENT',
    requiredTier: options.requiredTier ?? null,
    actualTier: tier ?? null,
    hint: `Upgrade to ${options.requiredTier} to access this site.`,
  });
}

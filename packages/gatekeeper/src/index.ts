/**
 * Gatekeeper SDK for Express.
 *
 * Denies access to any request whose client IP is not routed through an
 * active strict-proxy exit node. The authorized IP list is pulled from the
 * Central Controller, verified with its Ed25519 signature, and cached
 * in-memory with a TTL.
 */
import type { RequestHandler, Request, Response, NextFunction } from 'express';
import { loadSigningPublicKey, verifyJson } from '@strict-proxy/types';
import type { PublicIpsResponse } from '@strict-proxy/types';

export interface GatekeeperOptions {
  /** Central Controller base URL, e.g. https://controller.example.com */
  controllerBaseUrl: string;
  /**
   * Ed25519 public key PEM(s) used to verify the signed IP list, keyed by
   * keyId for rotation. At minimum the current controller key.
   */
  publicKeys: Record<string, string>;
  /** Cache TTL in seconds. Defaults to 300 (must be < controller list TTL). */
  cacheTtlSeconds?: number;
  /** Refetch timeout in ms. Defaults to 5000. */
  fetchTimeoutMs?: number;
  /**
   * Response for unauthorized (non-fleet) clients. Defaults to a 403 JSON
   * paywall payload. Set `redirectUrl` to send a 302 instead.
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
 *   }));
 */
export function createGatekeeperMiddleware(options: GatekeeperOptions): RequestHandler {
  const ttlMs = (options.cacheTtlSeconds ?? 300) * 1000;
  const failureClosed = (options.failureMode ?? 'closed') === 'closed';
  const log = options.logger ?? (() => undefined);
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
          deny(req, res, options);
          return;
        }
        next();
        return;
      }

      const ip = clientIpOf(req, options.trustForwardedFor ?? false);
      if (ip && ips.has(ip)) {
        next();
        return;
      }
      deny(req, res, options);
    })().catch(next);
  };
}

function deny(req: Request, res: Response, options: GatekeeperOptions): void {
  if ('redirectUrl' in (options.denyResponse ?? {})) {
    const target = (options.denyResponse as { redirectUrl: string }).redirectUrl;
    res.redirect(302, target);
    return;
  }
  const custom = options.denyResponse as { status: number; body: unknown } | undefined;
  res.status(custom?.status ?? 403).json(
    custom?.body ?? {
      error: 'Access denied: you must be connected through the strict-proxy network.',
      code: 'GATEKEEPER_DENIED',
      hint: 'Connect your VPN client and retry.',
    },
  );
}

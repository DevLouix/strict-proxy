/**
 * Shared Express middleware: JWT auth for the public API, HMAC verification
 * for node-internal API, and a JSON error handler.
 */
import type { Request, Response, NextFunction } from 'express';
import { safeEqual, hmacSign, buildHmacSigningString } from '@strict-proxy/types';
import { verifyAccessToken, isAccessRevoked, type AccessClaims } from './services/auth.js';
import { getRedis, setNx } from './redis.js';
import { users } from './db/schema.js';
import { eq } from 'drizzle-orm';
import type { ControllerConfig } from './env.js';
import type { Db } from './db/client.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AccessClaims;
      node?: { nodeId: string };
    }
  }
}

/** Extracts the bearer token or null. */
function bearer(req: Request): string | null {
  const h = req.header('authorization');
  if (!h) return null;
  const [scheme, token] = h.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

/** Requires a valid, non-revoked JWT. Populates req.auth. */
export function requireJwt(cfg: ControllerConfig, db: Db) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: 'missing bearer token', code: 'UNAUTHENTICATED' });
      return;
    }
    try {
      const claims = verifyAccessToken(cfg, token);
      if (await isAccessRevoked(db, claims.jti)) {
        res.status(401).json({ error: 'token revoked', code: 'TOKEN_REVOKED' });
        return;
      }
      const [user] = await db.select({ disabledAt: users.disabledAt, role: users.role }).from(users).where(eq(users.id, claims.sub)).limit(1);
      if (!user || user.disabledAt || user.role !== claims.role) {
        res.status(401).json({ error: 'account is unavailable', code: 'ACCOUNT_UNAVAILABLE' });
        return;
      }
      req.auth = claims;
      next();
    } catch {
      res.status(401).json({ error: 'invalid or expired token', code: 'UNAUTHENTICATED' });
    }
  };
}

/** Requires a valid JWT with the administrator role. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.role !== 'admin') {
    res.status(403).json({ error: 'administrator access required', code: 'FORBIDDEN' });
    return;
  }
  next();
}

/**
 * Requires a valid HMAC-signed internal request from a registered node.
 * Signature covers method, path, timestamp, nonce and raw body hash; nonce is
 * single-use via Redis to block replays.
 *
 * `lookupSecrets` returns every secret currently valid for the node: the active
 * one, plus the previous one while a rotation grace window is open. Returning a
 * list here is what lets a secret be rotated without re-enrolling the node.
 */
export function requireNodeHmac(cfg: ControllerConfig, db: Db, lookupSecrets: (nodeId: string) => Promise<string[] | null>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const nodeId = req.header('x-node-id');
      const timestamp = req.header('x-timestamp');
      const nonce = req.header('x-nonce');
      const signature = req.header('x-signature');
      if (!nodeId || !timestamp || !nonce || !signature) {
        res.status(401).json({ error: 'missing node auth headers', code: 'NODE_UNAUTHENTICATED' });
        return;
      }

      const ts = Number.parseInt(timestamp, 10);
      if (Number.isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > cfg.hmacTimestampToleranceSeconds) {
        res.status(401).json({ error: 'timestamp outside tolerance', code: 'NODE_STALE_TIMESTAMP' });
        return;
      }

      const secrets = await lookupSecrets(nodeId);
      if (!secrets || secrets.length === 0) {
        res.status(401).json({ error: 'unknown node', code: 'NODE_UNKNOWN' });
        return;
      }

      const raw = (req as Request & { rawBody?: Buffer }).rawBody;
      const body = raw ? raw.toString('utf8') : '';
      const signingString = buildHmacSigningString({ method: req.method, path: req.path, timestamp, nonce, body });
      // Accept the active secret or a not-yet-expired previous one, which is
      // what makes rotation possible without a simultaneous node restart.
      if (!secrets.some((secret) => safeEqual(hmacSign(secret, signingString), signature))) {
        res.status(401).json({ error: 'bad signature', code: 'NODE_BAD_SIGNATURE' });
        return;
      }

      const redis = getRedis(cfg.redisUrl);
      const fresh = await setNx(redis, `nonce:${nodeId}:${nonce}`, cfg.hmacTimestampToleranceSeconds);
      if (!fresh) {
        res.status(401).json({ error: 'nonce replayed', code: 'NODE_NONCE_REPLAY' });
        return;
      }

      req.node = { nodeId };
      next();
    })().catch(next);
  };
}

/** JSON error handler; keeps internals out of responses in production. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const message = err instanceof Error ? err.message : 'internal error';
  const code = message === 'device_seat_limit' ? 'DEVICE_SEAT_LIMIT' : message === 'no_nodes_available' ? 'NO_NODES_AVAILABLE' : message === 'invalid_or_expired_enrollment' ? 'INVALID_OR_EXPIRED_ENROLLMENT' : message === 'failed_to_enroll_node' ? 'NODE_ENROLLMENT_FAILED' : 'INTERNAL';
  const status = code === 'INTERNAL' ? 500 : 400;
  if (status === 500) console.error('[controller] unhandled error:', err);
  res.status(status).json({ error: status === 500 ? 'internal error' : message, code });
}

/** Async wrapper so rejected promises hit the error handler. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

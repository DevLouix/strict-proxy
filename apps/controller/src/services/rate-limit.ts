/**
 * Redis-backed fixed-window rate limiting.
 *
 * Used to throttle the unauthenticated auth surface (register / login /
 * refresh) against credential stuffing and password guessing, and the
 * payment webhook against signature-verification floods.
 *
 * The counter is incremented and its TTL set in a single atomic Lua script so
 * a crash between the two operations cannot leave a window without a TTL.
 */
import type { Request, Response, NextFunction } from 'express';
import type { Redis } from 'ioredis';
import type { ControllerConfig } from '../env.js';
import { asyncHandler } from '../middleware.js';
import { getRedis } from '../redis.js';

/** INCR + conditional EXPIRE, atomically. Returns the new counter value. */
const INCR_WITH_TTL = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

export interface RateLimitOptions {
  /** Logical bucket, e.g. 'auth.login'. Keeps limits independent per endpoint. */
  bucket: string;
  /**
   * Maximum requests allowed inside the window. Must be a positive integer.
   */
  maxAttempts: number;
  /** Window length in seconds. Must be a positive integer. */
  windowSeconds: number;
}

/**
 * Builds rate-limit middleware. Over-limit requests are rejected with 429 and
 * a Retry-After hint; the limit is applied per client IP.
 *
 * When Redis is unreachable the request is allowed through: the rate limiter is
 * a defence-in-depth control, and failing closed here would turn a cache outage
 * into a total authentication outage. The failure is logged instead.
 */
export function rateLimit(cfg: ControllerConfig, options: RateLimitOptions) {
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts));
  const windowSeconds = Math.max(1, Math.trunc(options.windowSeconds));

  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const redis = getRedis(cfg.redisUrl);
    const clientKey = req.ip ?? 'unknown';
    const redisKey = `ratelimit:${options.bucket}:${clientKey}`;

    let attempts: unknown;
    try {
      attempts = await redis.eval(INCR_WITH_TTL, 1, redisKey, String(windowSeconds));
    } catch (err) {
      console.error('[controller] rate limiter unavailable, allowing request:', err);
      next();
      return;
    }

    const count = Number(attempts);
    res.setHeader('X-RateLimit-Limit', String(maxAttempts));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxAttempts - count)));

    if (count > maxAttempts) {
      res.setHeader('Retry-After', String(windowSeconds));
      res.status(429).json({
        error: 'too many requests; retry later',
        code: 'RATE_LIMITED',
      });
      return;
    }

    next();
  });
}
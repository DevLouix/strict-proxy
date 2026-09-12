/**
 * Redis client (singleton) used for node heartbeat state, HMAC nonce replay
 * protection and short-lived caches.
 */
import { Redis } from 'ioredis';

let client: Redis | null = null;

export function getRedis(url: string): Redis {
  if (!client) {
    client = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => client?.disconnect());
    client = null;
  }
}

/**
 * SET-if-absent with TTL; returns true when the caller won the race.
 * Used for HMAC nonce replay protection and webhook idempotency fast-path.
 */
export async function setNx(redis: Redis, key: string, ttlSeconds: number): Promise<boolean> {
  const res = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
  return res === 'OK';
}

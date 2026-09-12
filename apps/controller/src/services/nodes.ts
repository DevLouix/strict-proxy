/**
 * Node registry + per-user credential provisioning.
 * A "credential" is one VLESS UUID + REALITY short-id scoped to (user, node).
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { nodeCredentials, nodes } from '../db/schema.js';
import { generateRealityKeypair } from '@strict-proxy/types';

/** Normalized load score 0..100 from a node's raw report. */
export function computeLoadScore(cpuPercent: number, memoryPercent: number): number {
  return Math.min(100, Math.round(cpuPercent * 0.6 + memoryPercent * 0.4));
}

/**
 * Registers (or re-registers) a node, returning its id and the HMAC secret
 * used for internal API authentication. The secret is generated here and
 * must be delivered to the node operator via a secure channel.
 */
export async function registerNode(
  db: Db,
  params: {
    hostname: string;
    region: string;
    publicIp: string;
    tunnelPort: number;
    realityPrivateKey?: string;
    realityPublicKey?: string;
    realityServerName: string;
    realityShortIds: string[];
    engineVersion: string;
    hmacSecret?: string;
  },
): Promise<{ nodeId: string; hmacSecret: string }> {
  let priv = params.realityPrivateKey;
  let pub = params.realityPublicKey;
  if (!priv || !pub) {
    const kp = generateRealityKeypair();
    priv = kp.privateKeyB64;
    pub = kp.publicKeyB64;
  }

  const hmacSecret = params.hmacSecret ?? randomBytes(32).toString('base64url');
  const [row] = await db
    .insert(nodes)
    .values({
      hostname: params.hostname,
      region: params.region,
      publicIp: params.publicIp,
      tunnelPort: params.tunnelPort,
      realityPrivateKey: priv,
      realityPublicKey: pub,
      realityServerName: params.realityServerName,
      realityShortIds: params.realityShortIds,
      engineVersion: params.engineVersion,
      hmacSecret,
      status: 'online',
      lastHeartbeatAt: new Date(),
    })
    .onConflictDoUpdate({
      target: nodes.hostname,
      set: {
        region: params.region,
        publicIp: params.publicIp,
        tunnelPort: params.tunnelPort,
        realityPrivateKey: priv,
        realityPublicKey: pub,
        realityServerName: params.realityServerName,
        realityShortIds: params.realityShortIds,
        engineVersion: params.engineVersion,
        hmacSecret,
        status: 'online',
        lastHeartbeatAt: new Date(),
      },
    })
    .returning({ id: nodes.id });

  if (!row) throw new Error('failed to register node');
  return { nodeId: row.id, hmacSecret };
}

/**
 * Ensures a VLESS credential exists for (user, node). Idempotent: an existing
 * non-revoked credential is returned as-is.
 */
export async function ensureUserCredential(db: Db, userId: string, nodeId: string): Promise<{ uuid: string; shortId: string; flow: string }> {
  const [existing] = await db
    .select({ uuid: nodeCredentials.uuid, shortId: nodeCredentials.shortId, flow: nodeCredentials.flow, revoked: nodeCredentials.revoked })
    .from(nodeCredentials)
    .where(and(eq(nodeCredentials.userId, userId), eq(nodeCredentials.nodeId, nodeId)))
    .limit(1);

  if (existing && !existing.revoked) return existing;

  if (existing && existing.revoked) {
    // Re-activate the same UUID on re-subscription.
    await db.update(nodeCredentials).set({ revoked: false, revokedAt: null }).where(and(eq(nodeCredentials.userId, userId), eq(nodeCredentials.nodeId, nodeId)));
    return { uuid: existing.uuid, shortId: existing.shortId, flow: existing.flow };
  }

  // Fresh credential: random UUID + a short-id drawn from the node's pool.
  const [node] = await db.select({ shortIds: nodes.realityShortIds }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) throw new Error('node_not_found');
  const pool = node.shortIds;
  if (!pool || pool.length === 0) throw new Error('node_short_id_pool_empty');
  const shortId = pool[Math.floor(Math.random() * pool.length)]!;

  const [created] = await db
    .insert(nodeCredentials)
    .values({ userId, nodeId, uuid: randomUUID(), shortId, flow: 'xtls-rprx-vision' })
    .onConflictDoUpdate({ target: [nodeCredentials.userId, nodeCredentials.nodeId], set: { revoked: false, revokedAt: null } })
    .returning({ uuid: nodeCredentials.uuid, shortId: nodeCredentials.shortId, flow: nodeCredentials.flow });

  if (!created) throw new Error('failed_to_provision_credential');
  return created;
}

/** Immediately revokes all credentials for a user (payment failure / churn). */
export async function revokeAllUserCredentials(db: Db, userId: string): Promise<number> {
  const rows = await db
    .update(nodeCredentials)
    .set({ revoked: true, revokedAt: new Date() })
    .where(and(eq(nodeCredentials.userId, userId), eq(nodeCredentials.revoked, false)))
    .returning({ id: nodeCredentials.id });
  return rows.length;
}

/** Marks credentials revoked for a set of users (bulk maintenance). */
export async function revokeCredentialsForUsers(db: Db, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await db
    .update(nodeCredentials)
    .set({ revoked: true, revokedAt: new Date() })
    .where(and(inArray(nodeCredentials.userId, userIds), eq(nodeCredentials.revoked, false)));
}

/** Nodes whose heartbeat is stale are flipped to offline. */
export async function refreshNodeStatus(db: Db, heartbeatTtlSeconds: number): Promise<void> {
  const cutoff = new Date(Date.now() - heartbeatTtlSeconds * 1000);
  await db.execute(sql`UPDATE nodes SET status = 'offline' WHERE status IN ('online','degraded') AND last_heartbeat_at < ${cutoff}`);
}

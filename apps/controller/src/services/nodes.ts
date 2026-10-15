/**
 * Node registry, secure VPS enrollment, and per-user credential provisioning.
 */
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { nodeCredentials, nodeEnrollments, nodes, subscriptions } from '../db/schema.js';
import { generateRealityKeypair } from '@strict-proxy/types';

/** Generates a one-time enrollment token and its database hash. */
export function createNodeEnrollmentToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: createHash('sha256').update(token, 'utf8').digest('hex') };
}

/** Hashes a presented enrollment token for database lookup. */
export function hashNodeEnrollmentToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Atomically consumes a one-time enrollment and creates the node in offline
 * state. The node becomes client-visible only after its first valid heartbeat.
 */
export async function enrollNode(
  db: Db,
  params: {
    token: string;
    hostname: string;
    label?: string;
    publicIp: string;
    tunnelPort: number;
    realityServerName: string;
    realityShortIds: string[];
    engineVersion: string;
  },
): Promise<{ nodeId: string; hmacSecret: string; region: string }> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [enrollment] = await tx
      .update(nodeEnrollments)
      .set({ usedAt: now })
      .where(and(eq(nodeEnrollments.tokenHash, hashNodeEnrollmentToken(params.token)), isNull(nodeEnrollments.usedAt), gt(nodeEnrollments.expiresAt, now)))
      .returning({ id: nodeEnrollments.id, region: nodeEnrollments.region });
    if (!enrollment) throw new Error('invalid_or_expired_enrollment');

    const reality = generateRealityKeypair();
    const hmacSecret = randomBytes(32).toString('base64url');
    const [node] = await tx
      .insert(nodes)
      .values({
        hostname: params.hostname,
        region: enrollment.region,
        label: params.label ?? null,
        publicIp: params.publicIp,
        tunnelPort: params.tunnelPort,
        realityPrivateKey: reality.privateKeyB64,
        realityPublicKey: reality.publicKeyB64,
        realityServerName: params.realityServerName,
        realityShortIds: params.realityShortIds,
        engineVersion: params.engineVersion,
        hmacSecret,
        status: 'offline',
      })
      .returning({ id: nodes.id });
    if (!node) throw new Error('failed_to_enroll_node');

    await tx.update(nodeEnrollments).set({ nodeId: node.id }).where(eq(nodeEnrollments.id, enrollment.id));
    return { nodeId: node.id, hmacSecret, region: enrollment.region };
  });
}

/** Normalized load score 0..100 from a node's raw report. */
export function computeLoadScore(cpuPercent: number, memoryPercent: number): number {
  return Math.min(100, Math.max(0, Math.round(cpuPercent * 0.6 + memoryPercent * 0.4)));
}

/**
 * Registers (or re-registers) a node, returning its id and HMAC secret.
 * This remains useful for controlled bootstrap/seed tooling; normal VPS
 * onboarding should use the one-time enrollment endpoint above.
 */
export async function registerNode(
  db: Db,
  params: {
    hostname: string;
    region: string;
    label?: string;
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
      label: params.label ?? null,
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
        label: params.label ?? null,
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

/** Ensures a VLESS credential exists for (user, node). */
export async function ensureUserCredential(db: Db, userId: string, nodeId: string): Promise<{ uuid: string; shortId: string; flow: string }> {
  const [existing] = await db
    .select({ uuid: nodeCredentials.uuid, shortId: nodeCredentials.shortId, flow: nodeCredentials.flow, revoked: nodeCredentials.revoked })
    .from(nodeCredentials)
    .where(and(eq(nodeCredentials.userId, userId), eq(nodeCredentials.nodeId, nodeId)))
    .limit(1);

  if (existing && !existing.revoked) return existing;

  if (existing && existing.revoked) {
    await db.update(nodeCredentials).set({ revoked: false, revokedAt: null }).where(and(eq(nodeCredentials.userId, userId), eq(nodeCredentials.nodeId, nodeId)));
    return { uuid: existing.uuid, shortId: existing.shortId, flow: existing.flow };
  }

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

/** Immediately revokes all credentials for a user. */
export async function revokeAllUserCredentials(db: Db, userId: string): Promise<number> {
  const rows = await db
    .update(nodeCredentials)
    .set({ revoked: true, revokedAt: new Date() })
    .where(and(eq(nodeCredentials.userId, userId), eq(nodeCredentials.revoked, false)))
    .returning({ id: nodeCredentials.id });
  return rows.length;
}

/**
 * Flips subscriptions whose billing period has elapsed from `active` to
 * `expired`.
 *
 * Access was already denied by the period-end check in the config route, but
 * the row itself kept claiming `active`. That made every status-based surface
 * lie: the admin overview counted lapsed customers as paying subscribers, and
 * `/api/v1/me` reported an active plan for someone who no longer had one.
 * Reconciling the row keeps status, the dashboard and access in agreement.
 */
export async function expireLapsedSubscriptions(db: Db): Promise<number> {
  const rows = await db
    .update(subscriptions)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(
      and(
        eq(subscriptions.status, 'active'),
        isNotNull(subscriptions.currentPeriodEnd),
        lt(subscriptions.currentPeriodEnd, new Date()),
      ),
    )
    .returning({ userId: subscriptions.userId });
  return rows.length;
}

/** Nodes whose heartbeat is stale are flipped to offline. */
export async function refreshNodeStatus(db: Db, heartbeatTtlSeconds: number): Promise<void> {
  const cutoff = new Date(Date.now() - heartbeatTtlSeconds * 1000);
  await db.execute(sql`UPDATE nodes SET status = 'offline' WHERE status IN ('online','degraded') AND last_heartbeat_at < ${cutoff}`);
}

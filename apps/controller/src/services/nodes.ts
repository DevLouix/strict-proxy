/**
 * Node registry, secure VPS enrollment, and per-user credential provisioning.
 */
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { nodeCredentials, nodeEnrollments, nodes, subscriptions } from '../db/schema.js';
import { generateRealityKeypair, isPublicIpAddress, normalizeIpAddress } from '@strict-proxy/types';

/** Generates a one-time enrollment token and its database hash. */
export function createNodeEnrollmentToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: createHash('sha256').update(token, 'utf8').digest('hex') };
}

/** Hashes a presented enrollment token for database lookup. */
export function hashNodeEnrollmentToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A validation failure the enroll route turns into a 400. */
export class EnrollmentValidationError extends Error {}

/** A DNS name, IPv4/IPv6 literal or registered hostname; no whitespace. */
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,251}[A-Za-z0-9])?$/;

function requiredText(value: unknown, field: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0 || text.length > max || /\s/.test(text)) {
    throw new EnrollmentValidationError(`${field} must be 1-${max} characters without whitespace`);
  }
  return text;
}

/**
 * Validates and normalises an enrollment payload.
 *
 * The token is operator-issued, but everything else is supplied by the agent and
 * rendered straight into the sing-box config. `realityShortIds` was accepted
 * verbatim, so a non-hex or odd-length value produced a config that `sing-box
 * check` rejects — a node that enrolled successfully and then served nobody.
 * `tunnelPort` was coerced with `Number()`, which turned a typo into NaN and
 * surfaced as a 500 instead of a 400 the agent could report.
 *
 * The empty short id is rejected on purpose: sing-box reads it as "accept any
 * short id", which would silently turn off that part of the REALITY handshake.
 */
export function validateEnrollmentInput(body: unknown): {
  token: string;
  hostname: string;
  label: string | null;
  tunnelPort: number;
  realityServerName: string;
  realityShortIds: string[];
  engineVersion: string;
} {
  const raw = (body ?? {}) as Record<string, unknown>;
  const token = requiredText(raw.token, 'token', 200);
  const hostname = requiredText(raw.hostname, 'hostname', 253);
  if (!HOSTNAME_RE.test(hostname)) {
    throw new EnrollmentValidationError('hostname must be a DNS name or address');
  }

  const realityServerName = requiredText(raw.realityServerName, 'realityServerName', 253);
  if (!HOSTNAME_RE.test(realityServerName)) {
    throw new EnrollmentValidationError('realityServerName must be a DNS name or address');
  }

  const port = raw.tunnelPort === undefined || raw.tunnelPort === null ? 443 : Number(raw.tunnelPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new EnrollmentValidationError('tunnelPort must be an integer between 1 and 65535');
  }

  if (!Array.isArray(raw.realityShortIds) || raw.realityShortIds.length === 0 || raw.realityShortIds.length > 16) {
    throw new EnrollmentValidationError('realityShortIds must be a non-empty array of at most 16 short ids');
  }
  const realityShortIds = raw.realityShortIds.map((value) => {
    const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{2,16}$/.test(id) || id.length % 2 !== 0) {
      throw new EnrollmentValidationError(
        `realityShortIds entries must be 2-16 hex characters in even length; got ${JSON.stringify(value)}`,
      );
    }
    return id;
  });
  if (new Set(realityShortIds).size !== realityShortIds.length) {
    throw new EnrollmentValidationError('realityShortIds entries must be unique');
  }

  let label: string | null = null;
  if (raw.label !== undefined && raw.label !== null) {
    const text = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (text.length > 100) throw new EnrollmentValidationError('label must be at most 100 characters');
    label = text.length === 0 ? null : text;
  }

  const engineVersion =
    typeof raw.engineVersion === 'string' && raw.engineVersion.trim() !== ''
      ? raw.engineVersion.trim().slice(0, 64)
      : 'unknown';

  return { token, hostname, label, tunnelPort: port, realityServerName, realityShortIds, engineVersion };
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
    /**
     * Provenance of `publicIp`. Defaults to 'enrollment'; pass 'autodetect'
     * when the address came from the enrolling connection rather than the body.
     */
    publicIpSource?: 'enrollment' | 'autodetect' | 'manual';
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
        publicIpSource: params.publicIpSource ?? 'enrollment',
        publicIpUpdatedAt: now,
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
  // Re-registering an existing hostname must not silently replace the node's
  // REALITY identity. The agent pulls its private key from bootstrap, and every
  // signed bundle already issued pins the matching public key: a fresh keypair
  // here rejects every client that still holds one (the node logs `REALITY:
  // processed invalid connection`) until that client refetches. A new keypair is
  // generated only for a new node, and an existing one is replaced only when the
  // caller pins the key explicitly, which is a deliberate rotation.
  let priv = params.realityPrivateKey;
  let pub = params.realityPublicKey;
  if (!priv || !pub) {
    const [existing] = await db
      .select({ privateKey: nodes.realityPrivateKey, publicKey: nodes.realityPublicKey })
      .from(nodes)
      .where(eq(nodes.hostname, params.hostname))
      .limit(1);
    if (existing) {
      priv = existing.privateKey;
      pub = existing.publicKey;
    } else {
      const kp = generateRealityKeypair();
      priv = kp.privateKeyB64;
      pub = kp.publicKeyB64;
    }
  }

  const hmacSecret = params.hmacSecret ?? randomBytes(32).toString('base64url');
  const [row] = await db
    .insert(nodes)
    .values({
      hostname: params.hostname,
      region: params.region,
      label: params.label ?? null,
      publicIp: params.publicIp,
      publicIpSource: 'manual',
      publicIpUpdatedAt: new Date(),
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
        publicIpSource: 'manual',
        publicIpUpdatedAt: new Date(),
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
 * Applies a node's self-reported public IP, when the deployment allows it.
 *
 * The Gatekeeper's trusted IP list is derived from `nodes.public_ip`, so a node
 * whose provider re-issues its address would otherwise stay allowlisted at a
 * stale address (and be missing from the real one) until an admin noticed. The
 * agent reports what it observes on every heartbeat; this accepts it only when
 * auto-detection is enabled and the value is a public address, records that it
 * was auto-detected, and reports whether anything changed so the caller can log.
 */
export async function applyObservedNodeIp(
  db: Db,
  cfg: { nodeIpAutodetect: boolean },
  nodeId: string,
  observedIp: string | undefined,
): Promise<{ changed: boolean; publicIp: string | null }> {
  const [node] = await db.select({ publicIp: nodes.publicIp }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) return { changed: false, publicIp: null };

  const normalized = observedIp === undefined ? null : normalizeIpAddress(observedIp);
  if (!cfg.nodeIpAutodetect || normalized === null || !isPublicIpAddress(normalized) || normalized === node.publicIp) {
    return { changed: false, publicIp: node.publicIp };
  }

  await db
    .update(nodes)
    .set({ publicIp: normalized, publicIpSource: 'autodetect', publicIpUpdatedAt: new Date() })
    .where(eq(nodes.id, nodeId));
  return { changed: true, publicIp: normalized };
}

/**
 * Ensures a VLESS credential exists for (user, node, install).
 *
 * The install is part of the identity so a seat can be granted, displaced and
 * revoked per device; a per-account credential was shared by every device,
 * which made seat accounting — and therefore limiting credential sharing —
 * impossible.
 */
export async function ensureUserCredential(
  db: Db,
  userId: string,
  nodeId: string,
  deviceId: string,
): Promise<{ uuid: string; shortId: string; flow: string }> {
  const [existing] = await db
    .select({ uuid: nodeCredentials.uuid, shortId: nodeCredentials.shortId, flow: nodeCredentials.flow, revoked: nodeCredentials.revoked })
    .from(nodeCredentials)
    .where(and(eq(nodeCredentials.userId, userId), eq(nodeCredentials.nodeId, nodeId), eq(nodeCredentials.deviceId, deviceId)))
    .limit(1);

  const [node] = await db.select({ shortIds: nodes.realityShortIds }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) throw new Error('node_not_found');
  const pool = node.shortIds;
  if (!pool || pool.length === 0) throw new Error('node_short_id_pool_empty');
  const pickShortId = () => pool[Math.floor(Math.random() * pool.length)]!;

  if (existing) {
    // The node only accepts the short ids in its current pool. A credential
    // issued against an older pool can never complete a REALITY handshake — the
    // node logs `processed invalid connection` and the client shows a tunnel
    // that carries nothing — so move the row onto the current pool instead of
    // keeping an install permanently unable to connect. The UUID is preserved:
    // usage accounting and session revocation key off it, not the short id.
    const shortId = pool.includes(existing.shortId) ? existing.shortId : pickShortId();
    const identity = and(
      eq(nodeCredentials.userId, userId),
      eq(nodeCredentials.nodeId, nodeId),
      eq(nodeCredentials.deviceId, deviceId),
    );
    if (existing.revoked) {
      await db
        .update(nodeCredentials)
        .set({ revoked: false, revokedAt: null, shortId })
        .where(identity);
    } else if (shortId !== existing.shortId) {
      await db.update(nodeCredentials).set({ shortId }).where(identity);
    }
    return { uuid: existing.uuid, shortId, flow: existing.flow };
  }

  const shortId = pickShortId();

  const [created] = await db
    .insert(nodeCredentials)
    .values({ userId, nodeId, deviceId, uuid: randomUUID(), shortId, flow: 'xtls-rprx-vision' })
    .onConflictDoUpdate({
      target: [nodeCredentials.userId, nodeCredentials.nodeId, nodeCredentials.deviceId],
      set: { revoked: false, revokedAt: null },
    })
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

/**
 * Dynamic sing-box configuration generator (VLESS + REALITY).
 *
 * Produces per-user, per-node client configs with unique credentials and
 * signs the resulting bundle with the controller's Ed25519 key so clients
 * (and the Gatekeeper SDK) can verify authenticity.
 */
import type { Db } from '../db/client.js';
import { nodeCredentials, nodes, users } from '../db/schema.js';
import { and, eq, gt, inArray, isNull, ne, notInArray, or } from 'drizzle-orm';
import { loadSigningPrivateKey, signJson } from '@strict-proxy/types';
import type { NodeEndpoint, SignedConfigBundle, SubscriptionTier, VlessRealityClientConfig } from '@strict-proxy/types';
import type { ControllerConfig } from '../env.js';
import { ensureUserCredential } from './nodes.js';
import { tierDefinition } from './tiers.js';

const CONFIG_TTL_SECONDS = 6 * 60 * 60; // clients re-fetch every 6h at most

/**
 * Ranks candidate nodes for assignment.
 *
 * Preference order: healthy nodes before degraded ones, then lowest reported
 * load, then node id as a deterministic tie-break so two users fetching at the
 * same time get a stable answer and a free-tier user limited to two nodes is
 * not pinned to whichever two happened to sort first.
 */
export function rankNodesForAssignment<T extends { id: string; loadScore: number; status: string }>(candidates: T[]): T[] {
  const statusRank = (status: string) => (status === 'online' ? 0 : 1);
  return [...candidates].sort((a, b) => {
    const byStatus = statusRank(a.status) - statusRank(b.status);
    if (byStatus !== 0) return byStatus;
    if (a.loadScore !== b.loadScore) return a.loadScore - b.loadScore;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Builds and signs the full config bundle for a user.
 * Only nodes that are currently online (or degraded) are included, ranked by
 * health so the least loaded are assigned first. Callers only reach this for
 * paid tiers; the tier's node cap is applied before signing.
 */
export async function buildSignedConfigBundle(
  db: Db,
  cfg: ControllerConfig,
  params: { userId: string; tier: SubscriptionTier; deviceId: string },
): Promise<SignedConfigBundle> {
  // Provision per-node credentials for this user before rendering configs,
  // so a fresh user immediately gets working VLESS UUIDs on every node.
  // A node whose engine is not running cannot carry a tunnel; offering it
  // anyway produced "connected" clients with no traffic. A node that has never
  // reported health is still usable — only a reported `false` excludes it.
  const usableNode = and(
    inArray(nodes.status, ['online', 'degraded']),
    or(isNull(nodes.engineHealthy), ne(nodes.engineHealthy, false)),
  );
  const activeNodes = await db
    .select({ id: nodes.id, loadScore: nodes.loadScore, status: nodes.status })
    .from(nodes)
    .where(usableNode);
  if (activeNodes.length === 0) {
    throw new Error('no_nodes_available');
  }

  // One proxy session per account: whichever install is issued this bundle is
  // the winner, so every other install's credentials are revoked. This runs
  // only after the bundle is known to be buildable — revoking first meant a
  // request that then failed with `no_nodes_available` had already destroyed
  // the credentials of a device that was working.
  await db
    .update(nodeCredentials)
    .set({ revoked: true, revokedAt: new Date() })
    .where(
      and(
        eq(nodeCredentials.userId, params.userId),
        eq(nodeCredentials.revoked, false),
        or(isNull(nodeCredentials.deviceId), ne(nodeCredentials.deviceId, params.deviceId)),
      ),
    );
  const maxNodes = Math.min(tierDefinition(params.tier).maxNodes, activeNodes.length);
  const allowedNodeIds = rankNodesForAssignment(activeNodes).slice(0, maxNodes).map((node) => node.id);
  for (const nodeId of allowedNodeIds) {
    await ensureUserCredential(db, params.userId, nodeId, params.deviceId);
  }
  await db
    .update(nodeCredentials)
    .set({ revoked: true, revokedAt: new Date() })
    .where(
      and(
        eq(nodeCredentials.userId, params.userId),
        eq(nodeCredentials.deviceId, params.deviceId),
        notInArray(nodeCredentials.nodeId, allowedNodeIds),
        eq(nodeCredentials.revoked, false),
      ),
    );

  const rows = await db
    .select({
      nodeId: nodes.id,
      hostname: nodes.hostname,
      region: nodes.region,
      label: nodes.label,
      publicIp: nodes.publicIp,
      status: nodes.status,
      loadScore: nodes.loadScore,
      tunnelPort: nodes.tunnelPort,
      realityPublicKey: nodes.realityPublicKey,
      realityServerName: nodes.realityServerName,
      credentialUuid: nodeCredentials.uuid,
      credentialShortId: nodeCredentials.shortId,
      flow: nodeCredentials.flow,
    })
    .from(nodes)
    .leftJoin(
      nodeCredentials,
      and(
        eq(nodeCredentials.nodeId, nodes.id),
        eq(nodeCredentials.userId, params.userId),
        eq(nodeCredentials.deviceId, params.deviceId),
        eq(nodeCredentials.revoked, false),
      ),
    )
    .where(and(usableNode, inArray(nodes.id, allowedNodeIds)));

  const limited = rows;

  const endpoints: NodeEndpoint[] = [];
  const configs: Record<string, VlessRealityClientConfig> = {};

  for (const row of limited) {
    if (!row.credentialUuid || !row.credentialShortId || !row.flow) continue;
    const endpoint: NodeEndpoint = {
      id: row.nodeId,
      hostname: row.hostname,
      region: row.region,
      label: row.label,
      publicIp: row.publicIp,
      status: row.status as NodeEndpoint['status'],
      loadScore: row.loadScore,
      tunnelHost: row.publicIp,
      tunnelPort: row.tunnelPort,
    };
    endpoints.push(endpoint);
    configs[row.nodeId] = {
      protocol: 'vless-reality',
      uuid: row.credentialUuid,
      server: row.publicIp,
      serverPort: row.tunnelPort,
      serverName: row.realityServerName,
      shortId: row.credentialShortId,
      publicKey: row.realityPublicKey,
      flow: row.flow,
      fingerprint: 'chrome',
      transport: 'tcp',
    };
  }

  const expiresAt = new Date(Date.now() + CONFIG_TTL_SECONDS * 1000).toISOString();
  const payload = { expiresAt, nodes: endpoints, configs };
  const key = loadSigningPrivateKey(cfg.signingPrivateKeyPem);
  const signature = signJson(key, payload);

  return { ...payload, signature, keyId: cfg.signingKeyId };
}

/**
 * Full desired credential state for one node — consumed by the node agent's
 * sync worker. Includes recently revoked credentials (24h window) so nodes
 * can deterministically clean up.
 */
export async function buildNodeSyncState(db: Db, nodeId: string) {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
  const rows = await db
    .select({
      uuid: nodeCredentials.uuid,
      shortId: nodeCredentials.shortId,
      revoked: nodeCredentials.revoked,
      email: users.email,
    })
    .from(nodeCredentials)
    .innerJoin(users, eq(users.id, nodeCredentials.userId))
    .where(and(eq(nodeCredentials.nodeId, nodeId), or(eq(nodeCredentials.revoked, false), gt(nodeCredentials.revokedAt, cutoff))))
    // Usage reporting updates these rows every minute, which moves them in the
    // table's heap order. Without a stable order the agent rendered a different
    // config for the same users and restarted the engine, dropping every tunnel
    // connection; the agent sorts too, so either side alone is enough.
    .orderBy(nodeCredentials.uuid);

  return {
    credentials: rows.map((r) => ({
      uuid: r.uuid,
      shortId: r.shortId,
      userEmail: r.email,
      expiresAt: null,
      revoked: r.revoked,
    })),
    controllerTime: new Date().toISOString(),
  };
}

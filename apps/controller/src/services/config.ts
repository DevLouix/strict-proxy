/**
 * Dynamic sing-box configuration generator (VLESS + REALITY).
 *
 * Produces per-user, per-node client configs with unique credentials and
 * signs the resulting bundle with the controller's Ed25519 key so clients
 * (and the Gatekeeper SDK) can verify authenticity.
 */
import type { Db } from '../db/client.js';
import { nodeCredentials, nodes, users } from '../db/schema.js';
import { and, eq, gt, inArray, or } from 'drizzle-orm';
import { loadSigningPrivateKey, signJson } from '@strict-proxy/types';
import type { NodeEndpoint, SignedConfigBundle, SubscriptionTier, VlessRealityClientConfig } from '@strict-proxy/types';
import type { ControllerConfig } from '../env.js';
import { ensureUserCredential } from './nodes.js';

const CONFIG_TTL_SECONDS = 6 * 60 * 60; // clients re-fetch every 6h at most

/**
 * Builds and signs the full config bundle for a user.
 * Only nodes that are currently online (or degraded) are included; free tier
 * users are limited to two nodes.
 */
export async function buildSignedConfigBundle(
  db: Db,
  cfg: ControllerConfig,
  params: { userId: string; tier: SubscriptionTier },
): Promise<SignedConfigBundle> {
  // Provision per-node credentials for this user before rendering configs,
  // so a fresh user immediately gets working VLESS UUIDs on every node.
  const activeNodes = await db.select({ id: nodes.id }).from(nodes).where(inArray(nodes.status, ['online', 'degraded']));
  if (activeNodes.length === 0) {
    throw new Error('no_nodes_available');
  }
  for (const node of activeNodes) {
    await ensureUserCredential(db, params.userId, node.id);
  }

  const rows = await db
    .select({
      nodeId: nodes.id,
      hostname: nodes.hostname,
      region: nodes.region,
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
      and(eq(nodeCredentials.nodeId, nodes.id), eq(nodeCredentials.userId, params.userId), eq(nodeCredentials.revoked, false)),
    )
    .where(inArray(nodes.status, ['online', 'degraded']));

  const freeLimit = params.tier === 'free' ? 2 : rows.length;
  const limited = rows.slice(0, freeLimit);

  const endpoints: NodeEndpoint[] = [];
  const configs: Record<string, VlessRealityClientConfig> = {};

  for (const row of limited) {
    if (!row.credentialUuid || !row.credentialShortId || !row.flow) continue;
    const endpoint: NodeEndpoint = {
      id: row.nodeId,
      hostname: row.hostname,
      region: row.region,
      publicIp: row.publicIp,
      status: row.status as NodeEndpoint['status'],
      loadScore: row.loadScore,
      tunnelHost: row.hostname,
      tunnelPort: row.tunnelPort,
    };
    endpoints.push(endpoint);
    configs[row.nodeId] = {
      protocol: 'vless-reality',
      uuid: row.credentialUuid,
      server: row.hostname,
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
    .where(and(eq(nodeCredentials.nodeId, nodeId), or(eq(nodeCredentials.revoked, false), gt(nodeCredentials.revokedAt, cutoff))));

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

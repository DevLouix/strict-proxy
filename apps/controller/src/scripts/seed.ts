/**
 * Development seed: admin user, a sample REALITY node, and a reminder of the
 * Ed25519 public key derived from the configured signing key.
 *
 * The seed never generates a signing key. The active key is owned by
 * `SIGNING_PRIVATE_KEY_PEM` in the environment (see `generate-env.ts`); minting
 * a second keypair here would print a key that does not match the one the
 * Gatekeeper and clients were configured with.
 */
import bcrypt from 'bcryptjs';
import { generateRealityKeypair } from '@strict-proxy/types';
import { createPublicKey, randomBytes } from 'node:crypto';
import { getDb } from '../db/client.js';
import { nodes, subscriptions, users } from '../db/schema.js';
import { loadConfig } from '../env.js';
import { registerNode } from '../services/nodes.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = getDb(cfg.databaseUrl);

  // --- signing key -----------------------------------------------------------
  // Report the public half of the key the controller will actually sign with.
  const publicKeyPem = createPublicKey(cfg.signingPrivateKeyPem.replace(/\\n/g, '\n'))
    .export({ type: 'spki', format: 'pem' })
    .toString();
  console.log('----------------------------------------------------------------');
  console.log(`Ed25519 signing key id: ${cfg.signingKeyId}`);
  console.log('PUBLIC key to share with the Gatekeeper SDK / client verification:');
  console.log(publicKeyPem);
  console.log('----------------------------------------------------------------');

  // --- admin user ------------------------------------------------------------
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@strict.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');
  const [admin] = await db
    .insert(users)
    .values({ email: adminEmail, passwordHash: await bcrypt.hash(adminPassword, 12), role: 'admin' })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });
  if (admin) {
    await db.insert(subscriptions).values({ userId: admin.id, tier: 'pro', status: 'active' }).onConflictDoNothing({ target: subscriptions.userId });
    console.log(`[seed] admin user: ${adminEmail} / ${adminPassword}  (save this!)`);
  }

  // --- sample node -----------------------------------------------------------
  const reality = generateRealityKeypair();
  const shortIds = [randomBytes(4).toString('hex'), randomBytes(4).toString('hex')];
  const { nodeId, hmacSecret } = await registerNode(db, {
    hostname: process.env.SEED_NODE_HOSTNAME ?? 'node-a.local',
    region: process.env.SEED_NODE_REGION ?? 'eu-central',
    publicIp: process.env.SEED_NODE_IP ?? '203.0.113.10',
    tunnelPort: 443,
    realityPrivateKey: reality.privateKeyB64,
    realityPublicKey: reality.publicKeyB64,
    realityServerName: cfg.defaultRealityServerName,
    realityShortIds: shortIds,
    engineVersion: '1.10.0',
  });
  console.log(`[seed] sample node registered: ${nodeId}`);
  console.log(`[seed] node HMAC secret (NODE_HMAC_SECRET for the agent env): ${hmacSecret}`);
  await closeRedisSafe();
  process.exit(0);
}

async function closeRedisSafe(): Promise<void> {
  try {
    const { closeRedis } = await import('../redis.js');
    await closeRedis();
  } catch {
    // no-op: redis may not have been initialized
  }
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});

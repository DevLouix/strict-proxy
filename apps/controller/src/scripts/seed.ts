/**
 * Development seed: admin user, Ed25519 signing key (printed for .env),
 * a sample REALITY node and its agent HMAC secret derivation note.
 */
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { generateEd25519Keypair, generateRealityKeypair } from '@strict-proxy/types';
import { randomBytes } from 'node:crypto';
import { getDb } from '../db/client.js';
import { nodes, signingKeys, subscriptions, users } from '../db/schema.js';
import { loadConfig } from '../env.js';
import { registerNode } from '../services/nodes.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = getDb(cfg.databaseUrl);

  // --- signing key -----------------------------------------------------------
  const existingKey = await db.select().from(signingKeys).where(eq(signingKeys.keyId, cfg.signingKeyId)).limit(1);
  if (existingKey.length === 0) {
    const kp = generateEd25519Keypair();
    await db.insert(signingKeys).values({ keyId: cfg.signingKeyId, publicKeyPem: kp.publicKeyPem, privateKeyPem: kp.privateKeyPem, active: true });
    console.log('----------------------------------------------------------------');
    console.log('NEW ED25519 SIGNING KEY generated. Put the private key in .env:');
    console.log(`SIGNING_PRIVATE_KEY_PEM="${kp.privateKeyPem.replace(/\n/g, '\\n')}"`);
    console.log('----------------------------------------------------------------');
  }

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

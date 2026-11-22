/**
 * Gatekeeper Key Factory service.
 *
 * Generates, hashes, validates, rotates, and revokes single-line site API keys
 * (`sp_gk_<8hex>_<secret>`) used by `@strict-proxy/gatekeeper` and
 * `strict-proxy-gatekeeper` to bootstrap exit-IP lists and the controller's
 * Ed25519 public key without manual multi-line PEM management.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { gatekeeperKeys } from '../db/schema.js';

export const GATEKEEPER_KEY_PREFIX = 'sp_gk_';
const KEY_FORMAT_RE = /^sp_gk_[a-f0-9]{8}_[A-Za-z0-9_-]{24,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GeneratedGatekeeperKey {
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
}

export interface GatekeeperKeyCreateInput {
  name: string;
  note: string | null;
  expiresAt: Date | null;
}

export interface GatekeeperKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  note: string | null;
  active: boolean;
  status: 'active' | 'revoked' | 'expired';
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function hashGatekeeperKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

export function isGatekeeperKeyFormat(rawKey: string): boolean {
  return KEY_FORMAT_RE.test(rawKey.trim());
}

export function isValidUuid(id: string): boolean {
  return UUID_RE.test(id);
}

/** Generates a high-entropy single-line Gatekeeper site key + display prefix + SHA-256 hash. */
export function generateGatekeeperKey(): GeneratedGatekeeperKey {
  const idPart = randomBytes(4).toString('hex');
  const secretPart = randomBytes(32).toString('base64url');
  const keyPrefix = `${GATEKEEPER_KEY_PREFIX}${idPart}`;
  const rawKey = `${keyPrefix}_${secretPart}`;
  return {
    rawKey,
    keyPrefix,
    keyHash: hashGatekeeperKey(rawKey),
  };
}

/** Validates and normalizes create-key request input. Throws Error on invalid fields. */
export function normalizeGatekeeperKeyInput(body: unknown, nowMs = Date.now()): GatekeeperKeyCreateInput {
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const rawName = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!rawName) {
    throw new Error('name is required');
  }
  if (rawName.length > 80) {
    throw new Error('name must be 80 characters or fewer');
  }

  let note: string | null = null;
  if (obj.note !== undefined && obj.note !== null) {
    if (typeof obj.note !== 'string') {
      throw new Error('note must be a string');
    }
    const trimmed = obj.note.trim();
    if (trimmed.length > 280) {
      throw new Error('note must be 280 characters or fewer');
    }
    note = trimmed || null;
  }

  let expiresAt: Date | null = null;
  if (obj.expiresInDays !== undefined && obj.expiresInDays !== null && obj.expiresInDays !== '') {
    const days = Number(obj.expiresInDays);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      throw new Error('expiresInDays must be a positive number up to 3650');
    }
    expiresAt = new Date(nowMs + Math.round(days * 86_400_000));
  } else if (obj.expiresAt !== undefined && obj.expiresAt !== null && obj.expiresAt !== '') {
    if (typeof obj.expiresAt !== 'string') {
      throw new Error('expiresAt must be an ISO timestamp string');
    }
    const parsed = Date.parse(obj.expiresAt);
    if (!Number.isFinite(parsed) || parsed <= nowMs) {
      throw new Error('expiresAt must be a valid future timestamp');
    }
    expiresAt = new Date(parsed);
  }

  return { name: rawName, note, expiresAt };
}

export function serializeGatekeeperKey(
  row: typeof gatekeeperKeys.$inferSelect,
  nowMs = Date.now(),
): GatekeeperKeySummary {
  const isExpired = Boolean(row.expiresAt && row.expiresAt.getTime() <= nowMs);
  const status: 'active' | 'revoked' | 'expired' = !row.active || row.revokedAt
    ? 'revoked'
    : isExpired
      ? 'expired'
      : 'active';

  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    note: row.note ?? null,
    active: status === 'active',
    status,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    lastUsedIp: row.lastUsedIp ?? null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listGatekeeperKeys(db: Db): Promise<GatekeeperKeySummary[]> {
  const rows = await db
    .select()
    .from(gatekeeperKeys)
    .orderBy(desc(gatekeeperKeys.createdAt));
  return rows.map((row) => serializeGatekeeperKey(row));
}

export async function createGatekeeperKey(
  db: Db,
  input: GatekeeperKeyCreateInput,
  createdBy: string | null,
): Promise<{ key: GatekeeperKeySummary; secret: string }> {
  const generated = generateGatekeeperKey();
  const [row] = await db
    .insert(gatekeeperKeys)
    .values({
      name: input.name,
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      note: input.note,
      active: true,
      expiresAt: input.expiresAt,
      createdBy,
    })
    .returning();
  return {
    key: serializeGatekeeperKey(row!),
    secret: generated.rawKey,
  };
}

export async function rotateGatekeeperKey(
  db: Db,
  id: string,
): Promise<{ key: GatekeeperKeySummary; secret: string } | null> {
  if (!isValidUuid(id)) return null;
  const generated = generateGatekeeperKey();
  const [row] = await db
    .update(gatekeeperKeys)
    .set({
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      active: true,
      revokedAt: null,
    })
    .where(eq(gatekeeperKeys.id, id))
    .returning();
  if (!row) return null;
  return {
    key: serializeGatekeeperKey(row),
    secret: generated.rawKey,
  };
}

export async function revokeGatekeeperKey(
  db: Db,
  id: string,
): Promise<GatekeeperKeySummary | null> {
  if (!isValidUuid(id)) return null;
  const [row] = await db
    .update(gatekeeperKeys)
    .set({
      active: false,
      revokedAt: new Date(),
    })
    .where(eq(gatekeeperKeys.id, id))
    .returning();
  if (!row) return null;
  return serializeGatekeeperKey(row);
}

export async function deleteGatekeeperKey(db: Db, id: string): Promise<boolean> {
  if (!isValidUuid(id)) return false;
  const deleted = await db
    .delete(gatekeeperKeys)
    .where(eq(gatekeeperKeys.id, id))
    .returning({ id: gatekeeperKeys.id });
  return deleted.length > 0;
}

export interface VerifiedGatekeeperSite {
  id: string;
  name: string;
  keyPrefix: string;
}

/**
 * Verifies a presented `sp_gk_...` secret against `gatekeeper_keys` and stamps
 * `lastUsedAt` / `lastUsedIp` on success.
 */
export async function verifyGatekeeperKey(
  db: Db,
  rawKey: string | undefined,
  clientIp?: string | null,
): Promise<VerifiedGatekeeperSite | null> {
  if (!rawKey) return null;
  const trimmed = rawKey.trim();
  if (!isGatekeeperKeyFormat(trimmed)) return null;

  const candidateHash = hashGatekeeperKey(trimmed);
  const [row] = await db
    .select()
    .from(gatekeeperKeys)
    .where(eq(gatekeeperKeys.keyHash, candidateHash))
    .limit(1);

  if (!row) return null;

  const a = Buffer.from(row.keyHash, 'hex');
  const b = Buffer.from(candidateHash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  if (!row.active || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  // Stamp usage (best effort — never deny a valid site on a telemetry write blip).
  try {
    await db
      .update(gatekeeperKeys)
      .set({
        lastUsedAt: new Date(),
        ...(clientIp ? { lastUsedIp: clientIp } : {}),
      })
      .where(eq(gatekeeperKeys.id, row.id));
  } catch (err) {
    console.warn('[controller] failed to stamp gatekeeper key usage:', err);
  }

  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
  };
}

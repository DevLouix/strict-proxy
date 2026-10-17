/**
 * Operator-editable platform settings, with secrets encrypted at rest.
 *
 * SMTP credentials are configured from the admin dashboard rather than the
 * environment, because they are per-deployment and rotate independently of a
 * deploy. That puts a password in the database, so it is encrypted with
 * AES-256-GCM under a key derived from a deployment secret.
 *
 * Two rules hold throughout:
 *
 * 1. A secret is never returned by an API call. `describeSettings` reports that
 *    a value exists and whether it was changed, never the value itself. There is
 *    no read-back path, by design — an admin who can read the password back
 *    gains nothing over one who can only replace it.
 * 2. Writing an empty value to a secret clears it rather than storing nothing.
 *    Otherwise "leave blank to keep" and "clear it" would be indistinguishable,
 *    which is how a stale password silently survives a rotation.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import { platformSettings } from '../db/schema.js';

/** Marks a stored value as encrypted. Versioned so the scheme can change. */
const ENC_PREFIX = 'enc:v1:';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/** Encrypts a secret for storage. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

/**
 * Decrypts a stored secret.
 *
 * Throws on tampering or a wrong key. A settings row that cannot be decrypted is
 * a real failure — silently returning garbage would turn into an authentication
 * error against the mail server that looks like a credentials problem.
 */
export function decryptSecret(stored: string, key: Buffer): string {
  if (!stored.startsWith(ENC_PREFIX)) {
    throw new Error('stored secret is not encrypted; refusing to treat it as plaintext');
  }
  // Split off the whole prefix first. The prefix itself contains a colon, so
  // splitting the full string would shift every field by one.
  const parts = stored.slice(ENC_PREFIX.length).split(':');
  const [ivB64, tagB64, dataB64] = parts;
  if (parts.length !== 3 || ivB64 === undefined || tagB64 === undefined || dataB64 === undefined) {
    throw new Error(`stored secret is malformed: expected 3 fields, got ${parts.length}`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * Derives the settings encryption key.
 *
 * `SETTINGS_ENCRYPTION_KEY` is preferred so the key can be rotated on its own
 * schedule; the JWT secret is the fallback so a deployment is not bricked by
 * forgetting the variable. Both are deployment secrets and never leave the host.
 */
export function settingsKey(cfg: ControllerConfig): Buffer {
  const source = cfg.settingsEncryptionKey?.trim() || cfg.jwtSecret;
  return createHash('sha256').update(`strict-proxy/settings/v1:${source}`, 'utf8').digest();
}

/** Whether a stored value is encrypted. */
export function isEncrypted(stored: string): boolean {
  return stored.startsWith(ENC_PREFIX);
}

export interface SettingWrite {
  key: string;
  value: string;
  /** Encrypt at rest and never return. Defaults to false. */
  secret?: boolean;
}

export interface DescribedSetting {
  key: string;
  /** Always null for a secret — there is no read-back path. */
  value: string | null;
  isSecret: boolean;
  /** True when a secret exists, without disclosing it. */
  hasValue: boolean;
  updatedAt: Date;
}

/** Reads one setting. Secrets are returned only when `revealSecrets` is set. */
export async function getSetting(
  db: Db,
  cfg: ControllerConfig,
  key: string,
  opts: { revealSecrets?: boolean } = {},
): Promise<string | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key)).limit(1);
  if (!row) return null;
  if (!row.isSecret) return row.value;
  if (!opts.revealSecrets) throw new Error(`refusing to reveal secret setting ${key}`);
  return decryptSecret(row.value, settingsKey(cfg));
}

/**
 * Writes a setting.
 *
 * A secret written as an empty string is deleted, which is how an operator
 * clears a stored password without needing a delete endpoint.
 */
export async function setSetting(db: Db, cfg: ControllerConfig, write: SettingWrite, updatedBy?: string): Promise<void> {
  const key = write.key.trim();
  if (!key) throw new Error('setting key is required');

  if (write.secret && write.value === '') {
    await db.delete(platformSettings).where(eq(platformSettings.key, key));
    return;
  }

  const value = write.secret ? encryptSecret(write.value, settingsKey(cfg)) : write.value;
  await db
    .insert(platformSettings)
    .values({ key, value, isSecret: write.secret ?? false, updatedBy: updatedBy ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value, isSecret: write.secret ?? false, updatedBy: updatedBy ?? null, updatedAt: new Date() },
    });
}

/** Deletes a setting. */
export async function deleteSetting(db: Db, key: string): Promise<void> {
  await db.delete(platformSettings).where(eq(platformSettings.key, key));
}

/** All settings in [keyPrefix], safe to return over an API. */
export async function describeSettings(db: Db, prefix: string): Promise<DescribedSetting[]> {
  const rows = await db.select().from(platformSettings);
  return rows
    .filter((r) => r.key.startsWith(prefix))
    .map((r) => ({
      key: r.key,
      value: r.isSecret ? null : r.value,
      isSecret: r.isSecret,
      hasValue: r.value.length > 0,
      updatedAt: r.updatedAt,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
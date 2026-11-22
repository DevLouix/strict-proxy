import { createPublicKey, verify, type KeyObject } from 'node:crypto';

const keyCache = new Map<string, KeyObject>();

/**
 * Normalizes a PEM key loaded from environment variables (`.env`, Docker,
 * Vercel, Render, Dokploy, etc.), where newlines are frequently stored as
 * literal `\n` escape sequences or wrapped in quotes.
 */
export function normalizePem(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
  return s;
}

/**
 * Validates that a supplied `publicKey` string is actually a controller Ed25519
 * SPKI PEM and not a Gatekeeper site key (`sp_gk_...`) or a proxy node Reality/X25519
 * public key. Returns the normalized PEM or throws an actionable error.
 */
export function validatePublicKeyPem(raw: string): string {
  const normalized = normalizePem(raw);
  if (normalized.startsWith('sp_gk_')) {
    throw new Error(
      'Gatekeeper.init(): `publicKey` received a Gatekeeper site API key (`sp_gk_...`). Pass it as `apiKey` instead.',
    );
  }
  if (!normalized.includes('-----BEGIN PUBLIC KEY-----') || !normalized.includes('-----END PUBLIC KEY-----')) {
    throw new Error(
      'Gatekeeper.init(): invalid `publicKey` — expected the controller Ed25519 signing PEM starting with "-----BEGIN PUBLIC KEY-----" (from Admin -> Links), not a proxy node public key. Tip: generate a single-line site `apiKey` (`sp_gk_...`) in Admin -> Links -> Key Factory, or omit `publicKey` to auto-fetch.',
    );
  }
  return normalized;
}

/**
 * Deterministic canonical JSON serialization matching StrictProxy's controller
 * signing format: sorted object keys, no whitespace, undefined fields omitted.
 */
export function canonicalJson(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return JSON.stringify(payload);
  if (Array.isArray(payload)) return `[${payload.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(payload as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Loads and caches an Ed25519 SPKI public key from PEM. */
export function loadSigningPublicKey(cacheKey: string, publicKeyPem: string): KeyObject {
  const normalized = normalizePem(publicKeyPem);
  const composite = `${cacheKey}\n${normalized}`;
  const cached = keyCache.get(composite);
  if (cached) return cached;
  const key = createPublicKey(normalized);
  keyCache.set(composite, key);
  return key;
}

/** Verifies an Ed25519 canonical-JSON signature; safe for untrusted input. */
export function verifyJson(publicKey: KeyObject, payload: unknown, signatureB64: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonicalJson(payload), 'utf8'),
      publicKey,
      Buffer.from(signatureB64, 'base64'),
    );
  } catch {
    return false;
  }
}

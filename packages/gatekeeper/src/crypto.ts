import { createPublicKey, verify, type KeyObject } from 'node:crypto';

const keyCache = new Map<string, KeyObject>();

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
  const composite = `${cacheKey}
${publicKeyPem}`;
  const cached = keyCache.get(composite);
  if (cached) return cached;
  const key = createPublicKey(publicKeyPem);
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

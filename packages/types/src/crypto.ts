/**
 * Cryptographic primitives shared across modules.
 * - HMAC-SHA256 request signing for Node <-> Controller internal API.
 * - Ed25519 signing/verification for public artifacts (node IP list, client configs).
 * All secrets come from environment variables; nothing is hardcoded.
 */
import { createHmac, createHash, timingSafeEqual, createPrivateKey, createPublicKey, sign, verify, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

// ---------------------------------------------------------------------------
// HMAC (node agent <-> controller)
// ---------------------------------------------------------------------------

/**
 * Builds the canonical string-to-sign for internal API requests.
 * Order matters and must match the verifier on the other side.
 */
export function buildHmacSigningString(params: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  /** Raw request body, empty string for GET. */
  body: string;
}): string {
  return `${params.method.toUpperCase()}\n${params.path}\n${params.timestamp}\n${params.nonce}\n${sha256Hex(params.body)}`;
}

/** Computes the base64 HMAC-SHA256 signature over the signing string. */
export function hmacSign(secret: string, signingString: string): string {
  return createHmac('sha256', secret).update(signingString, 'utf8').digest('base64');
}

export interface HmacHeaders {
  'x-node-id': string;
  'x-timestamp': string;
  'x-nonce': string;
  'x-signature': string;
}

/** Convenience to produce auth headers for an internal request. */
export function buildHmacHeaders(params: {
  nodeId: string;
  secret: string;
  method: string;
  path: string;
  body: string;
  nonce?: string;
}): HmacHeaders {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = params.nonce ?? randomBytes(12).toString('hex');
  const signing = buildHmacSigningString({ method: params.method, path: params.path, timestamp, nonce, body: params.body });
  return {
    'x-node-id': params.nodeId,
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature': hmacSign(params.secret, signing),
  };
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** SHA-256 hex digest. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Ed25519 (public artifact signing: config bundles, public IP lists)
// ---------------------------------------------------------------------------

/** Generates an Ed25519 keypair; returns PEMs for storage in env/secrets. */
export function generateEd25519Keypair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

let cachedPrivateKey: KeyObject | null = null;

/** Loads (and caches) the Ed25519 private key from a PEM env var. */
export function loadSigningPrivateKey(pem: string): KeyObject {
  if (!cachedPrivateKey) {
    cachedPrivateKey = createPrivateKey(pem.replace(/\\n/g, '\n'));
  }
  return cachedPrivateKey;
}

let cachedPublicKeys = new Map<string, KeyObject>();

/** Loads (and caches) an Ed25519 public key by id, for verification. */
export function loadSigningPublicKey(keyId: string, pem: string): KeyObject {
  let key = cachedPublicKeys.get(keyId);
  if (!key) {
    key = createPublicKey(pem.replace(/\\n/g, '\n'));
    cachedPublicKeys.set(keyId, key);
  }
  return key;
}

/** Signs a payload deterministically over its canonical JSON form. */
export function signJson(privateKey: KeyObject, payload: unknown): string {
  return sign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64');
}

/** Verifies a canonical-JSON signature; safe for untrusted input. */
export function verifyJson(publicKey: KeyObject, payload: unknown, signatureB64: string): boolean {
  try {
    return verify(null, Buffer.from(canonicalJson(payload), 'utf8'), publicKey, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/** Deterministic JSON serialization: sorted keys, no whitespace. */
export function canonicalJson(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return JSON.stringify(payload);
  if (Array.isArray(payload)) return `[${payload.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(payload as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// REALITY (x25519) key helpers
// ---------------------------------------------------------------------------

/** Generates an x25519 keypair for sing-box REALITY, base64url-encoded (raw 32 bytes). */
export function generateRealityKeypair(): { privateKeyB64: string; publicKeyB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16, 48); // PKCS8 prefix is 16 bytes for x25519
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(12); // SPKI prefix is 12 bytes for x25519
  return { privateKeyB64: rawToB64Url(privRaw as Buffer), publicKeyB64: rawToB64Url(pubRaw as Buffer) };
}

function rawToB64Url(buf: Buffer): string {
  return Buffer.from(buf).toString('base64url');
}

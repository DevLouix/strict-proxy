/**
 * Emits canonical-JSON and signature fixtures from the controller's own code so
 * the Dart mirror can be tested against real bytes instead of a guess.
 */
import { generateEd25519Keypair, signJson } from '@strict-proxy/types';
import { createPrivateKey, createPublicKey } from 'node:crypto';

const kp = generateEd25519Keypair();
const spki = createPublicKey(kp.publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer;
const priv = createPrivateKey(kp.privateKeyPem);

// Mirror of canonicalJson in packages/types/src/crypto.ts, imported indirectly
// by signJson, re-implemented here only to report the exact signed text.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** A node shaped exactly like the one the controller emits, so fixtures can
 * also be fed through the client's `ServerNode.fromJson`. */
const realNode = {
  id: '5f1c2b6e-0a1d-4c2f-9e3b-7a8d9c0e1f23',
  hostname: 'ng-lagos-01',
  label: 'Lagos 01',
  region: 'ng-lagos',
  publicIp: '102.89.34.17',
  status: 'online',
  loadScore: 12,
  tunnelHost: 'edge.lagos.strictproxy.example',
  tunnelPort: 443,
};

const payloads: unknown[] = [
  { expiresAt: '2026-12-01T00:00:00.000Z', nodes: [], configs: {} },
  {
    expiresAt: '2026-12-01T00:00:00.000Z',
    nodes: [realNode],
    configs: {
      '5f1c2b6e-0a1d-4c2f-9e3b-7a8d9c0e1f23': {
        protocol: 'vless-reality',
        server: 'edge.lagos.strictproxy.example',
        serverPort: 443,
        flow: 'xtls-rprx-vision',
        publicKey: 'xQ0hZ2RmY1F4R3l1eFZ4Y2hEZVZ6cXAyZGRHZjRlQUFC',
      },
    },
  },
  // Deliberately awkward: unsorted keys, mixed types, nesting, null. Exercises
  // canonical-JSON ordering only; not a shape the client parses.
  {
    expiresAt: '2027-01-31T23:59:59.999Z',
    nodes: [{ zulu: 1, alpha: 2, mike: [true, false, null], nested: { b: 2, a: 1 } }],
    configs: {},
  },
];

/**
 * A complete wire bundle — the shape the controller actually sends, signature
 * included. Index 1 of [fixtures]; the client tests parse and verify this.
 */
const wireBundle = { ...(payloads[1] as object), keyId: 'kid-fixture' } as Record<string, unknown>;
const wireCanonical = canonical({ expiresAt: (payloads[1] as any).expiresAt, nodes: (payloads[1] as any).nodes, configs: (payloads[1] as any).configs });

process.stdout.write(
  JSON.stringify(
    {
      publicKeyBase64: spki.subarray(spki.length - 32).toString('base64'),
      fixtures: payloads.map((payload) => ({
        payload,
        canonical: canonical(payload),
        signature: signJson(priv, payload),
      })),
      // The signature covers only {expiresAt, nodes, configs} — keyId and
      // signature are transport metadata added after signing.
      wireBundle: {
        ...wireBundle,
        signature: signJson(priv, { expiresAt: wireBundle.expiresAt, nodes: wireBundle.nodes, configs: wireBundle.configs }),
        signedCanonical: wireCanonical,
      },
    },
    null,
    2,
  ),
);
/**
 * Unit tests for the shared crypto primitives. These are the primitives the
 * node HMAC API, the Gatekeeper IP list and the client config bundle all
 * depend on, so they are covered without any infrastructure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import {
  buildHmacSigningString,
  buildHmacHeaders,
  hmacSign,
  safeEqual,
  sha256Hex,
  generateEd25519Keypair,
  signJson,
  verifyJson,
  canonicalJson,
  generateRealityKeypair,
  loadSigningPrivateKey,
  loadSigningPublicKey,
} from '@strict-proxy/types';

test('canonicalJson sorts object keys and drops undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(5), '5');
});

test('canonicalJson is order-independent for equal objects', () => {
  assert.equal(canonicalJson({ x: 1, y: { p: 1, q: 2 } }), canonicalJson({ y: { q: 2, p: 1 }, x: 1 }));
});

test('HMAC signing string covers method, path, timestamp, nonce and body', () => {
  const s = buildHmacSigningString({ method: 'post', path: '/internal/v1/node/heartbeat', timestamp: '1700000000', nonce: 'abc', body: '{"a":1}' });
  assert.equal(
    s,
    `POST\n/internal/v1/node/heartbeat\n1700000000\nabc\n${sha256Hex('{"a":1}')}`,
  );
});

test('HMAC signing string differs when any covered field changes', () => {
  const base = { method: 'GET', path: '/x', timestamp: '1', nonce: 'n', body: '' };
  const s = buildHmacSigningString(base);
  assert.notEqual(s, buildHmacSigningString({ ...base, method: 'POST' }));
  assert.notEqual(s, buildHmacSigningString({ ...base, path: '/y' }));
  assert.notEqual(s, buildHmacSigningString({ ...base, timestamp: '2' }));
  assert.notEqual(s, buildHmacSigningString({ ...base, nonce: 'm' }));
  assert.notEqual(s, buildHmacSigningString({ ...base, body: '{}' }));
});

test('buildHmacHeaders produces verifiable headers', () => {
  const headers = buildHmacHeaders({ nodeId: 'n1', secret: 's3cret', method: 'GET', path: '/internal/v1/node/sync', body: '' });
  const expected = hmacSign(
    's3cret',
    buildHmacSigningString({ method: 'GET', path: '/internal/v1/node/sync', timestamp: headers['x-timestamp'], nonce: headers['x-nonce'], body: '' }),
  );
  assert.equal(headers['x-node-id'], 'n1');
  assert.ok(safeEqual(expected, headers['x-signature']));
});

test('buildHmacHeaders uses a fresh nonce when none is supplied', () => {
  const a = buildHmacHeaders({ nodeId: 'n1', secret: 's', method: 'GET', path: '/p', body: '' });
  const b = buildHmacHeaders({ nodeId: 'n1', secret: 's', method: 'GET', path: '/p', body: '' });
  assert.notEqual(a['x-nonce'], b['x-nonce']);
});

test('safeEqual rejects mismatched and equal-length-but-different values', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'abcd'));
});

test('Ed25519 signatures verify and fail closed on tampering', () => {
  const { privateKeyPem, publicKeyPem } = generateEd25519Keypair();
  const priv = createPrivateKey(privateKeyPem);
  const pub = createPublicKey(publicKeyPem);

  const payload = { ips: ['1.2.3.4'], generatedAt: 'now', expiresAt: 'later' };
  const sig = signJson(priv, payload);
  assert.ok(verifyJson(pub, payload, sig));

  // Any field change must invalidate the signature.
  assert.ok(!verifyJson(pub, { ...payload, ips: ['5.6.7.8'] }, sig));
  assert.ok(!verifyJson(pub, { ...payload, generatedAt: 'other' }, sig));
  assert.ok(!verifyJson(pub, payload, 'not-a-signature'));
  // Key ordering in the payload object must not matter (canonical JSON).
  assert.ok(verifyJson(pub, { expiresAt: 'later', ips: ['1.2.3.4'], generatedAt: 'now' }, sig));
});

test('a signature from a different key does not verify', () => {
  const a = generateEd25519Keypair();
  const b = generateEd25519Keypair();
  const sig = signJson(createPrivateKey(a.privateKeyPem), { x: 1 });
  assert.ok(!verifyJson(createPublicKey(b.publicKeyPem), { x: 1 }, sig));
});

test('generateRealityKeypair returns 32-byte base64url x25519 halves', () => {
  const { privateKeyB64, publicKeyB64 } = generateRealityKeypair();
  const priv = Buffer.from(privateKeyB64, 'base64url');
  const pub = Buffer.from(publicKeyB64, 'base64url');
  assert.equal(priv.length, 32);
  assert.equal(pub.length, 32);
  assert.notEqual(privateKeyB64, publicKeyB64);
});

test('generateEd25519Keypair is non-deterministic', () => {
  const a = generateEd25519Keypair();
  const b = generateEd25519Keypair();
  assert.notEqual(a.privateKeyPem, b.privateKeyPem);
  assert.notEqual(a.publicKeyPem, b.publicKeyPem);
});

test('loadSigningPublicKey does not let a reused key id mask different key material', () => {
  const first = generateEd25519Keypair();
  const second = generateEd25519Keypair();

  // Same id, different material: the second load must be a genuinely different
  // key, otherwise verification silently succeeds against the wrong key.
  const a = loadSigningPublicKey('primary', first.publicKeyPem);
  const b = loadSigningPublicKey('primary', second.publicKeyPem);
  assert.notDeepEqual(a.export({ type: 'spki', format: 'der' }), b.export({ type: 'spki', format: 'der' }));

  // And the second key must reject a signature made with the first.
  const sig = signJson(createPrivateKey(first.privateKeyPem), { x: 1 });
  assert.ok(verifyJson(b, { x: 1 }, sig) === false);
});

test('loadSigningPublicKey still returns a cached object for identical material', () => {
  const kp = generateEd25519Keypair();
  assert.equal(loadSigningPublicKey('cached', kp.publicKeyPem), loadSigningPublicKey('cached', kp.publicKeyPem));
});

test('loadSigningPrivateKey honours the PEM it is given', () => {
  const first = generateEd25519Keypair();
  const second = generateEd25519Keypair();
  const a = loadSigningPrivateKey(first.privateKeyPem);
  const b = loadSigningPrivateKey(second.privateKeyPem);
  assert.notDeepEqual(a.export({ type: 'pkcs8', format: 'der' }), b.export({ type: 'pkcs8', format: 'der' }));
});

test('key loaders accept PEMs with escaped newlines', () => {
  const kp = generateEd25519Keypair();
  const escaped = kp.privateKeyPem.replace(/\n/g, '\\n');
  const priv = loadSigningPrivateKey(escaped);
  const payload = { ips: ['10.0.0.1'] };
  const pub = loadSigningPublicKey('escaped', kp.publicKeyPem.replace(/\n/g, '\\n'));
  assert.ok(verifyJson(pub, payload, signJson(priv, payload)));
});
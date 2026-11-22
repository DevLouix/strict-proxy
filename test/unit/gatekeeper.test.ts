/**
 * Unit tests for the Gatekeeper client-IP extraction. This function decides who
 * is admitted, so spoofing behaviour must be pinned down explicitly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signJson } from '@strict-proxy/types';
import {
  clientIpOf,
  createGatekeeperMiddleware,
  entitlementTokenOf,
} from '@strict-proxy/gatekeeper';

function req(opts: { xff?: string; remoteAddress?: string }): any {
  return {
    header: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? opts.xff : undefined),
    socket: { remoteAddress: opts.remoteAddress },
  };
}

test('without trustForwardedFor the socket address is used', () => {
  assert.equal(clientIpOf(req({ xff: '9.9.9.9', remoteAddress: '1.2.3.4' }), false), '1.2.3.4');
});

test('with trustForwardedFor the first X-Forwarded-For hop is used', () => {
  assert.equal(clientIpOf(req({ xff: '9.9.9.9, 8.8.8.8, 1.1.1.1', remoteAddress: '127.0.0.1' }), true), '9.9.9.9');
});

test('with trustForwardedFor an absent header falls back to the socket', () => {
  assert.equal(clientIpOf(req({ remoteAddress: '1.2.3.4' }), true), '1.2.3.4');
});

test('IPv6-mapped IPv4 addresses are normalized to bare IPv4', () => {
  assert.equal(clientIpOf(req({ remoteAddress: '::ffff:203.0.113.7' }), false), '203.0.113.7');
});

test('native IPv6 addresses are preserved', () => {
  assert.equal(clientIpOf(req({ remoteAddress: '2001:db8::1' }), false), '2001:db8::1');
});

test('a missing remote address yields null rather than a bogus match', () => {
  assert.equal(clientIpOf(req({}), false), null);
});

test('an empty X-Forwarded-For entry does not produce an empty string result', () => {
  assert.equal(clientIpOf(req({ xff: ' , 8.8.8.8', remoteAddress: '1.2.3.4' }), true), '1.2.3.4');
});

// ---------------------------------------------------------------------------
// Entitlement token sources
// ---------------------------------------------------------------------------

function tokenReq(opts: { headers?: Record<string, string>; query?: Record<string, unknown> } = {}): any {
  const headers = opts.headers ?? {};
  return {
    header: (name: string) => headers[name.toLowerCase()],
    query: opts.query ?? {},
  };
}

test('the entitlement header is the primary source', () => {
  const r = tokenReq({ headers: { 'x-strict-proxy-entitlement': 'sp1.header.sig' } });
  assert.equal(entitlementTokenOf(r), 'sp1.header.sig');
});

test('a browser link ticket is accepted when no header is present', () => {
  // A top-level navigation cannot set a header; the controller mints a
  // short-lived ticket into the link instead.
  const r = tokenReq({ query: { sp_ticket: 'sp1.link.sig' } });
  assert.equal(entitlementTokenOf(r), 'sp1.link.sig');
});

test('the header wins over a ticket', () => {
  const r = tokenReq({
    headers: { 'x-strict-proxy-entitlement': 'sp1.header.sig' },
    query: { sp_ticket: 'sp1.link.sig' },
  });
  assert.equal(entitlementTokenOf(r), 'sp1.header.sig');
});

test('a cookie is the last fallback', () => {
  const r = tokenReq({ headers: { cookie: 'a=1; sp_entitlement=sp1.cookie.sig; b=2' } });
  assert.equal(entitlementTokenOf(r), 'sp1.cookie.sig');
});

test('no token anywhere yields undefined rather than an empty string', () => {
  assert.equal(entitlementTokenOf(tokenReq()), undefined);
  assert.equal(entitlementTokenOf(tokenReq({ headers: { cookie: 'other=1' } })), undefined);
  assert.equal(entitlementTokenOf(tokenReq({ query: { sp_ticket: '' } })), undefined);
});

test('source names can be overridden per deployment', () => {
  const r = tokenReq({
    headers: { 'x-my-plan': 'sp1.header.sig' },
    query: { plan_ticket: 'sp1.link.sig' },
  });
  assert.equal(
    entitlementTokenOf(r, 'x-my-plan', { queryParam: 'plan_ticket', cookieName: 'plan' }),
    'sp1.header.sig',
  );
  assert.equal(
    entitlementTokenOf(tokenReq({ query: { plan_ticket: 'sp1.link.sig' } }), 'x-my-plan', {
      queryParam: 'plan_ticket',
    }),
    'sp1.link.sig',
  );
});
test('IPv6-mapped IPv4 inside X-Forwarded-For is normalized', () => {
  assert.equal(
    clientIpOf(req({ xff: '::ffff:203.0.113.7, 10.0.0.1', remoteAddress: '127.0.0.1' }), true),
    '203.0.113.7',
  );
});

test('trustedProxyHops selects from the right so spoofed leading XFF entries are ignored', () => {
  // Client sent a forged leading header, then one reverse proxy appended the real exit IP.
  assert.equal(
    clientIpOf(req({ xff: '198.51.100.99, 203.0.113.10', remoteAddress: '127.0.0.1' }), true, 1),
    '203.0.113.10',
  );
  // Two reverse proxies in front of the app: hop 2 from the right is the client exit IP.
  assert.equal(
    clientIpOf(req({ xff: '198.51.100.99, 203.0.113.10, 10.0.0.2', remoteAddress: '127.0.0.1' }), true, 2),
    '203.0.113.10',
  );
});

function makeSignedTestMaterials() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const now = Date.now();
  const expiresAt = new Date(now + 10 * 60 * 1000).toISOString();
  const publicIpsPayload = {
    generatedAt: new Date(now).toISOString(),
    expiresAt,
    ips: ['203.0.113.10'],
  };
  const publicIpsBody = {
    ...publicIpsPayload,
    keyId: 'k1',
    signature: signJson(privateKey, publicIpsPayload),
  };
  const claims = {
    version: 1,
    sub: 'user-1',
    email: 'member@example.com',
    tier: 'pro',
    status: 'active',
    issuedAt: new Date(now).toISOString(),
    expiresAt,
    currentPeriodEnd: new Date(now + 30 * 86_400_000).toISOString(),
    keyId: 'k1',
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sigB64Url = Buffer.from(signJson(privateKey, claims), 'base64').toString('base64url');
  const token = `sp1.${payloadB64}.${sigB64Url}`;
  return { publicKeyPem, publicIpsBody, token };
}

test('createGatekeeperMiddleware persists a valid ?sp_ticket= into an HttpOnly cookie for follow-up requests', async () => {
  const { publicKeyPem, publicIpsBody, token } = makeSignedTestMaterials();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => publicIpsBody,
  })) as typeof fetch;

  try {
    const mw = createGatekeeperMiddleware({
      controllerBaseUrl: 'https://controller.test',
      publicKeys: { k1: publicKeyPem },
      requiredTier: 'standard',
      trustForwardedFor: true,
      trustedProxyHops: 1,
    });

    const appended: Array<[string, string]> = [];
    const fakeReq: any = {
      secure: false,
      header: (name: string) => {
        const key = name.toLowerCase();
        if (key === 'x-forwarded-for') return '198.51.100.99, 203.0.113.10';
        if (key === 'x-forwarded-proto') return 'https';
        return undefined;
      },
      query: { sp_ticket: token },
      socket: { remoteAddress: '127.0.0.1' },
    };
    const fakeRes: any = {
      append: (name: string, val: string) => appended.push([name, val]),
      status: () => {
        throw new Error('expected request to be admitted');
      },
    };

    await new Promise<void>((resolve, reject) => {
      mw(fakeReq, fakeRes, (err?: unknown) => (err ? reject(err) : resolve()));
    });

    assert.equal(fakeReq.strictProxy?.tier, 'pro');
    assert.equal(appended.length, 1);
    const [headerName, cookieVal] = appended[0]!;
    assert.equal(headerName, 'Set-Cookie');
    assert.ok(cookieVal.startsWith(`sp_entitlement=${token};`));
    assert.ok(cookieVal.includes('HttpOnly'));
    assert.ok(cookieVal.includes('SameSite=Lax'));
    assert.ok(cookieVal.includes('Secure'));
    assert.match(cookieVal, /Max-Age=\d+/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('createGatekeeperMiddleware skips Set-Cookie when setCookieFromQuery is false', async () => {
  const { publicKeyPem, publicIpsBody, token } = makeSignedTestMaterials();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => publicIpsBody,
  })) as typeof fetch;

  try {
    const mw = createGatekeeperMiddleware({
      controllerBaseUrl: 'https://controller.test',
      publicKeys: { k1: publicKeyPem },
      requiredTier: 'standard',
      setCookieFromQuery: false,
    });

    const appended: Array<[string, string]> = [];
    const fakeReq: any = {
      secure: true,
      header: () => undefined,
      query: { sp_ticket: token },
      socket: { remoteAddress: '203.0.113.10' },
    };
    const fakeRes: any = {
      append: (name: string, val: string) => appended.push([name, val]),
      status: () => {
        throw new Error('expected request to be admitted');
      },
    };

    await new Promise<void>((resolve, reject) => {
      mw(fakeReq, fakeRes, (err?: unknown) => (err ? reject(err) : resolve()));
    });

    assert.equal(appended.length, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

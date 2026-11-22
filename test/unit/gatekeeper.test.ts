/**
 * Unit tests for the Gatekeeper client-IP extraction. This function decides who
 * is admitted, so spoofing behaviour must be pinned down explicitly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signJson } from '@strict-proxy/types';
import {
  Gatekeeper,
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

test('Gatekeeper.init() + auth() supports single publicKey shorthand and per-route tier override', async () => {
  const { publicKeyPem, publicIpsBody, token } = makeSignedTestMaterials();
  const gk = Gatekeeper.init({
    controllerUrl: 'https://controller.test/',
    publicKey: publicKeyPem,
    trustForwardedFor: true,
    trustedProxyHops: 1,
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      json: async () => publicIpsBody,
    })) as typeof fetch,
  });

  // Proxy-only route (no requiredTier) admits fleet IP without token
  const proxyOnly = await gk.authorize({
    ip: '127.0.0.1',
    headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.10' },
  });
  assert.equal(proxyOnly.allowed, true);
  if (proxyOnly.allowed) {
    assert.equal(proxyOnly.ip, '203.0.113.10');
    assert.equal(proxyOnly.user, null);
  }

  // Per-route pro override via Web Standard Request
  const webReq = new Request(`https://private.example.com/pro?sp_ticket=${encodeURIComponent(token)}`, {
    headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.10' },
  });
  const proDecision = await gk.verifyRequest(webReq, 'pro');
  assert.equal(proDecision.allowed, true);
  if (proDecision.allowed) {
    assert.equal(proDecision.user?.tier, 'pro');
    assert.ok(proDecision.setCookie?.includes('HttpOnly'));
    assert.ok(proDecision.setCookie?.includes('Secure'));
  }

  // Refresh returns active fleet IPs
  assert.deepEqual(await gk.refresh(), ['203.0.113.10']);
});

test('Gatekeeper.init() auto-fetches public key over HTTPS and refuses non-localhost HTTP', async () => {
  const { publicKeyPem, publicIpsBody, token } = makeSignedTestMaterials();
  const fakeFetch = (async (url: string | URL) => {
    const s = String(url);
    if (s.endsWith('/api/v1/network/public-key')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ keyId: 'k1', algorithm: 'Ed25519', publicKeyPem }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => publicIpsBody,
    };
  }) as typeof fetch;

  const gkHttps = Gatekeeper.init({
    controllerUrl: 'https://controller.test',
    requiredTier: 'standard',
    fetchImpl: fakeFetch,
  });
  const okDecision = await gkHttps.authorize({
    ip: '203.0.113.10',
    headers: { 'x-strict-proxy-entitlement': token },
  });
  assert.equal(okDecision.allowed, true);

  // Remote plain HTTP without a pinned publicKey must fail closed
  const gkHttp = Gatekeeper.init({
    controllerUrl: 'http://controller.test',
    fetchImpl: fakeFetch,
  });
  const denied = await gkHttp.authorize({ ip: '203.0.113.10' });
  assert.equal(denied.allowed, false);
  if (!denied.allowed) {
    assert.equal(denied.status, 403);
    assert.equal(denied.code, 'GATEKEEPER_DENIED');
  }
});

test('Gatekeeper.init() reads STRICT_PROXY_* environment variables when omitted', async () => {
  const { publicKeyPem, publicIpsBody } = makeSignedTestMaterials();
  const prevUrl = process.env.STRICT_PROXY_CONTROLLER_URL;
  const prevKey = process.env.STRICT_PROXY_PUBLIC_KEY_PEM;
  process.env.STRICT_PROXY_CONTROLLER_URL = 'https://controller.test';
  process.env.STRICT_PROXY_PUBLIC_KEY_PEM = publicKeyPem;
  try {
    const gk = Gatekeeper.init({
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => publicIpsBody,
      })) as typeof fetch,
    });
    assert.deepEqual(await gk.refresh(), ['203.0.113.10']);
  } finally {
    if (prevUrl === undefined) delete process.env.STRICT_PROXY_CONTROLLER_URL;
    else process.env.STRICT_PROXY_CONTROLLER_URL = prevUrl;
    if (prevKey === undefined) delete process.env.STRICT_PROXY_PUBLIC_KEY_PEM;
    else process.env.STRICT_PROXY_PUBLIC_KEY_PEM = prevKey;
  }
});

test('Gatekeeper normalizes escaped \\n in PEM env vars, strips IP:port, and reports status()', async () => {
  const { publicKeyPem, publicIpsBody } = makeSignedTestMaterials();
  const escapedPem = `"${publicKeyPem.replace(/\n/g, '\\n')}"`;
  const gk = Gatekeeper.init({
    controllerUrl: 'https://controller.test/#links',
    publicKey: escapedPem,
    trustForwardedFor: true,
    trustedProxyHops: 1,
    logger: false,
    fetchImpl: (async (url: string | URL) => {
      assert.equal(String(url), 'https://controller.test/api/v1/network/nodes/public-ips');
      return { ok: true, status: 200, json: async () => publicIpsBody };
    }) as typeof fetch,
  });

  const ok = await gk.authorize({
    ip: '127.0.0.1',
    headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.10:54321' },
  });
  assert.equal(ok.allowed, true);
  assert.equal(gk.status().lastError, null);
  assert.deepEqual(gk.status().cachedIps, ['203.0.113.10']);

  const bad = await gk.authorize({
    ip: '127.0.0.1',
    headers: { 'x-forwarded-for': '198.51.100.99' },
  });
  assert.equal(bad.allowed, false);
  if (!bad.allowed) {
    assert.equal(bad.ip, '198.51.100.99');
    assert.equal(bad.fetchError, undefined);
  }
});

test('Gatekeeper surfaces fetchError on denied decisions and status() when controller fails', async () => {
  const { publicKeyPem } = makeSignedTestMaterials();
  const gk = Gatekeeper.init({
    controllerUrl: 'https://controller.test',
    publicKey: publicKeyPem,
    logger: false,
    fetchImpl: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as typeof fetch,
  });
  const res = await gk.authorize({ ip: '203.0.113.10' });
  assert.equal(res.allowed, false);
  if (!res.allowed) {
    assert.equal(res.ip, '203.0.113.10');
    assert.match(res.fetchError ?? '', /503/);
  }
  assert.match(gk.status().lastError ?? '', /503/);
});

test('Gatekeeper.init() with apiKey bootstraps exit IPs + Ed25519 key in one request', async () => {
  const { publicKeyPem, publicIpsBody, token } = makeSignedTestMaterials();
  let seenAuth = '';
  let seenUrl = '';
  const gk = Gatekeeper.init({
    controllerUrl: 'https://controller.test',
    apiKey: 'sp_gk_deadbeef_0123456789abcdefghijklmnopqrstuvwxyz',
    requiredTier: 'standard',
    logger: false,
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenAuth = headers.authorization ?? headers.Authorization ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          site: { id: 's1', name: 'Partner Portal', keyPrefix: 'sp_gk_deadbeef' },
          algorithm: 'Ed25519',
          publicKeyPem,
          ...publicIpsBody,
        }),
      };
    }) as typeof fetch,
  });

  const decision = await gk.authorize({
    ip: '203.0.113.10',
    headers: { 'x-strict-proxy-entitlement': token },
  });
  assert.equal(decision.allowed, true);
  assert.equal(seenUrl, 'https://controller.test/api/v1/gatekeeper/bootstrap');
  assert.equal(seenAuth, 'Bearer sp_gk_deadbeef_0123456789abcdefghijklmnopqrstuvwxyz');
  assert.equal(gk.status().authMode, 'api-key');
  assert.equal(gk.status().hasApiKey, true);
  assert.deepEqual(gk.status().cachedIps, ['203.0.113.10']);
});

test('Gatekeeper.init() rejects a node public key or sp_gk_ site key passed to publicKey', () => {
  assert.throws(
    () =>
      Gatekeeper.init({
        controllerUrl: 'https://controller.test',
        publicKey: 'sp_gk_deadbeef_0123456789abcdefghijklmnopqrstuvwxyz',
      }),
    /Pass it as `apiKey` instead/,
  );

  assert.throws(
    () =>
      Gatekeeper.init({
        controllerUrl: 'https://controller.test',
        publicKey: 'm4h5s8W2kQp9L1xYz0AbCdEfGhIjKlMnOpQrStUvWxY=',
      }),
    /not a proxy node public key/,
  );
});

test('Gatekeeper unwraps nested fetch err.cause details (TLS / ECONNREFUSED / AggregateError)', async () => {
  const { publicKeyPem } = makeSignedTestMaterials();
  const rootCause = Object.assign(new Error('unable to verify the first certificate'), {
    code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  });
  const fetchErr = Object.assign(new TypeError('fetch failed'), { cause: rootCause });

  const gk = Gatekeeper.init({
    controllerUrl: 'https://controller.test',
    publicKey: publicKeyPem,
    logger: false,
    fetchImpl: (async () => {
      throw fetchErr;
    }) as typeof fetch,
  });

  const res = await gk.authorize({ ip: '203.0.113.10' });
  assert.equal(res.allowed, false);
  if (!res.allowed) {
    assert.match(res.fetchError ?? '', /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
    assert.match(res.fetchError ?? '', /controller\.test\/api\/v1\/network\/nodes\/public-ips/);
  }
  assert.match(gk.status().lastError ?? '', /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
});

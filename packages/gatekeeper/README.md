# @strict-proxy/gatekeeper

Official Node.js & TypeScript SDK for **StrictProxy Gatekeeper**.

Lock down any website or API in two steps — **init**, then **auth** — so only users connected through your StrictProxy VPN fleet (and optionally holding a `standard` or `pro` subscription) can access it.

- **Zero runtime dependencies** — uses only Node.js built-in `node:crypto` (Ed25519) and global `fetch` (Node 20+).
- **Offline verification** — verifies signed fleet IP lists and signed entitlement tokens locally with zero per-request calls to your controller.
- **Seamless browser tickets** — automatically upgrades `?sp_ticket=` links from the StrictProxy app into an `HttpOnly` session cookie so follow-up clicks and assets stay authorized.
- **Framework-friendly** — first-class Express middleware (`gk.auth()`), Web Standard `Request` support (`gk.verifyRequest()` for Next.js / Hono / Bun / Deno), and framework-agnostic `gk.authorize()`.

---

## Install

```bash
npm install @strict-proxy/gatekeeper
```

---

## Quick Start (Init -> Auth)

Copy your **Controller URL** and **Signing Public Key** from your StrictProxy admin console at **`/admin#links`**.

### 1. Express (3 lines)

```ts
import express from 'express';
import { Gatekeeper } from '@strict-proxy/gatekeeper';

const app = express();

// 1. Init
const gk = Gatekeeper.init({
  controllerUrl: process.env.STRICT_PROXY_CONTROLLER_URL!, // e.g. https://proxy.example.com
  publicKey: process.env.STRICT_PROXY_PUBLIC_KEY_PEM!,     // Ed25519 PEM from /admin#links
  trustForwardedFor: true,
  trustedProxyHops: 1, // set to the number of reverse proxies (Caddy/Nginx) in front of your app
});

// 2. Auth — protect every route (proxy-only: any connected StrictProxy user)
app.use(gk.auth());

// Optional: require a paid plan on specific routes
app.get('/members', gk.auth('standard'), (req, res) => {
  res.json({ hello: req.strictProxy?.email, tier: req.strictProxy?.tier });
});

app.get('/pro', gk.auth('pro'), (req, res) => {
  res.json({ vip: true, user: req.strictProxy });
});

app.listen(4000);
```

### Zero-config via environment variables

Set these environment variables:

```bash
STRICT_PROXY_CONTROLLER_URL=https://proxy.example.com
STRICT_PROXY_PUBLIC_KEY_PEM="-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----"
```

Then initialize with zero boilerplate:

```ts
const gk = Gatekeeper.init({ requiredTier: 'standard' });
app.use(gk.auth());
```

> **Tip:** If you omit `publicKey` on an `https://` controller, the SDK can auto-fetch the signing key from `/api/v1/network/public-key` on first use. For production deployments, pinning `STRICT_PROXY_PUBLIC_KEY_PEM` is strongly recommended so your site verifies signatures against a key you control.

---

## Framework Examples

### Fastify

```ts
import Fastify from 'fastify';
import { Gatekeeper } from '@strict-proxy/gatekeeper';

const app = Fastify();
const gk = Gatekeeper.init({
  controllerUrl: process.env.STRICT_PROXY_CONTROLLER_URL!,
  publicKey: process.env.STRICT_PROXY_PUBLIC_KEY_PEM!,
  requiredTier: 'standard',
  trustForwardedFor: true,
  trustedProxyHops: 1,
});

app.addHook('onRequest', async (request, reply) => {
  const decision = await gk.authorize({
    ip: request.socket.remoteAddress,
    headers: request.headers,
    query: request.query as Record<string, unknown>,
    secure: request.protocol === 'https',
  });
  if (!decision.allowed) {
    if (decision.redirectUrl) return reply.redirect(decision.redirectUrl, 302);
    return reply.code(decision.status).send(decision.body);
  }
  if (decision.setCookie) reply.header('Set-Cookie', decision.setCookie);
});
```

### Next.js App Router (Route Handler)

```ts
import { NextRequest, NextResponse } from 'next/server';
import { Gatekeeper } from '@strict-proxy/gatekeeper';

const gk = Gatekeeper.init({
  controllerUrl: process.env.STRICT_PROXY_CONTROLLER_URL!,
  publicKey: process.env.STRICT_PROXY_PUBLIC_KEY_PEM!,
  requiredTier: 'standard',
  trustForwardedFor: true,
  trustedProxyHops: 1,
});

export async function GET(request: NextRequest) {
  const decision = await gk.verifyRequest(request);
  if (!decision.allowed) {
    if (decision.redirectUrl) {
      return NextResponse.redirect(decision.redirectUrl, 302);
    }
    return NextResponse.json(decision.body, { status: decision.status });
  }

  const res = NextResponse.json({ ok: true, user: decision.user });
  if (decision.setCookie) res.headers.append('Set-Cookie', decision.setCookie);
  return res;
}
```

### Hono

```ts
import { Hono } from 'hono';
import { Gatekeeper } from '@strict-proxy/gatekeeper';

const app = new Hono();
const gk = Gatekeeper.init({
  controllerUrl: process.env.STRICT_PROXY_CONTROLLER_URL!,
  publicKey: process.env.STRICT_PROXY_PUBLIC_KEY_PEM!,
  trustForwardedFor: true,
  trustedProxyHops: 1,
});

app.use('*', async (c, next) => {
  const decision = await gk.verifyRequest(c.req.raw);
  if (!decision.allowed) {
    if (decision.redirectUrl) return c.redirect(decision.redirectUrl, 302);
    return c.json(decision.body, decision.status as 401 | 403);
  }
  if (decision.setCookie) c.header('Set-Cookie', decision.setCookie, { append: true });
  await next();
});
```

---

## How Access Modes Work

| Mode | Configuration | Who is admitted? |
| --- | --- | --- |
| **Proxy-only** | Omit `requiredTier` (or pass `gk.auth({ requiredTier: null })`) | Any user whose traffic exits an active StrictProxy node. |
| **Standard & Pro** | `requiredTier: 'standard'` or `gk.auth('standard')` | Connected via StrictProxy **and** holding a signed `standard` or `pro` entitlement token. |
| **Pro only** | `requiredTier: 'pro'` or `gk.auth('pro')` | Connected via StrictProxy **and** holding a signed `pro` entitlement token. |

Entitlement tokens are accepted in priority order:
1. Header: `X-Strict-Proxy-Entitlement: sp1.<claims>.<sig>`
2. Query ticket: `?sp_ticket=sp1.<claims>.<sig>` (automatically persisted to the `sp_entitlement` `HttpOnly` cookie on first valid visit)
3. Cookie: `sp_entitlement=sp1.<claims>.<sig>`

---

## Configuration Reference

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `controllerUrl` | `string` | `STRICT_PROXY_CONTROLLER_URL` | Base URL of your StrictProxy controller. |
| `publicKey` | `string` | `STRICT_PROXY_PUBLIC_KEY_PEM` | Single Ed25519 SPKI public key PEM from `/admin#links`. |
| `publicKeys` | `Record<string, string>` | — | Map of `keyId -> PEM` for zero-downtime key rotation. |
| `requiredTier` | `'free' \| 'standard' \| 'pro'` | `undefined` | Minimum plan tier (omit for proxy-only). |
| `trustForwardedFor` | `boolean` | `false` | Enable when behind a reverse proxy (Caddy/Nginx/Cloudflare). |
| `trustedProxyHops` | `number` | `undefined` | Number of appending reverse proxies in front of your app (`1` for a single proxy). Prevents `X-Forwarded-For` spoofing. |
| `failureMode` | `'closed' \| 'open'` | `'closed'` | `'closed'` denies traffic if the allowlist cannot be refreshed. |
| `cacheTtlSeconds` | `number` | `300` | How long to cache the verified exit-IP list locally. |
| `fetchTimeoutMs` | `number` | `5000` | Timeout in milliseconds when fetching controller metadata. |
| `setCookieFromQuery` | `boolean` | `true` | Persist valid `?sp_ticket=` tokens to an `HttpOnly; SameSite=Lax` cookie. |
| `denyResponse` | `{ status, body } \| { redirectUrl }` | Built-in JSON | Custom denial response or 302 redirect URL. |

---

## API Reference

- `Gatekeeper.init(options?)` — Creates a configured Gatekeeper instance.
- `gk.auth(tierOrOptions?)` — Returns Express / Connect middleware.
- `gk.verify(req, tierOrOptions?)` — Async check for Node/Express/Fastify-like requests returning `AuthDecision`.
- `gk.verifyRequest(request, tierOrOptions?, remoteIp?)` — Async check for Web Standard `Request`.
- `gk.authorize({ ip, headers, query, secure }, tierOrOptions?)` — Framework-agnostic async check.
- `gk.verifyToken(token)` — Synchronous offline verification of an `sp1.*` entitlement token.
- `gk.refresh()` — Force-refreshes and returns the verified exit-IP list.
- `createGatekeeperMiddleware(options)` — Legacy Express middleware helper (fully supported).

---

## Error Codes

| HTTP Status | `code` | Meaning |
| --- | --- | --- |
| `403` | `GATEKEEPER_DENIED` | Request did not exit an active StrictProxy node (or controller unreachable in `closed` mode). |
| `401` | `GATEKEEPER_ENTITLEMENT_REQUIRED` | Route requires a plan, and no token was supplied. |
| `401` | `GATEKEEPER_ENTITLEMENT_INVALID` | Token is malformed, expired, or has an invalid Ed25519 signature. |
| `403` | `GATEKEEPER_TIER_INSUFFICIENT` | User's signed plan tier is below `requiredTier`. |

---

## Publishing to npm

```bash
cd packages/gatekeeper
npm run build
npm pack --dry-run
npm publish --access public
```

---

## License

MIT

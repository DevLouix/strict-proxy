# @strict-proxy/gatekeeper

**Lock your website so ONLY your StrictProxy users can open it.**

Think of Gatekeeper like a **bouncer at the front door of your website**:
1. Someone visits your website.
2. Gatekeeper checks: *"Did this person come through your StrictProxy VPN?"*
3. If **YES** -> let them in!
4. If **NO** -> politely block them (`403 Access Denied`).

You can also ask the bouncer to check their **VIP pass** (their `standard` or `pro` plan).

---

## Set It Up in 3 Easy Steps

### Step 1 — Install the package

```bash
npm install @strict-proxy/gatekeeper
```

> Needs Node.js 20 or newer. Zero extra dependencies.

### Step 2 — Grab 2 values from your StrictProxy Admin Console

1. Open your controller admin page at **`https://YOUR-CONTROLLER/admin#links`**.
2. Copy:
   - Your **Controller URL** (example: `https://proxy.example.com`)
   - Your **Signing Public Key** (click **Copy public key**)
3. Put them in your site's `.env` file:

```env
STRICT_PROXY_CONTROLLER_URL=https://proxy.example.com
STRICT_PROXY_PUBLIC_KEY_PEM="-----BEGIN PUBLIC KEY-----
paste-your-public-key-here
-----END PUBLIC KEY-----"
```

### Step 3 — Init, then Auth (3 lines of code!)

```js
import express from 'express';
import { Gatekeeper } from '@strict-proxy/gatekeeper';

const app = express();

// 1. INIT — tell the bouncer where your StrictProxy controller is
//    (automatically reads STRICT_PROXY_CONTROLLER_URL and STRICT_PROXY_PUBLIC_KEY_PEM from .env!)
const gk = Gatekeeper.init();

// 2. AUTH — put the bouncer in front of your whole website
app.use(gk.auth());

app.get('/', (req, res) => {
  res.send('Welcome! You are connected through StrictProxy.');
});

app.listen(4000);
```

That's it! Anyone NOT connected to your StrictProxy VPN is now blocked automatically.

---

## Pick Who Gets In (Proxy-Only vs Paid Plans)

You can protect your whole site, or put different rules on different pages:

```js
// Anyone connected to your StrictProxy VPN (no plan check)
app.use(gk.auth());

// Only Standard or Pro plan users
app.get('/members', gk.auth('standard'), (req, res) => {
  res.json({
    message: 'Welcome member!',
    email: req.strictProxy.email,
    plan: req.strictProxy.tier,
  });
});

// Only Pro plan users
app.get('/vip', gk.auth('pro'), (req, res) => {
  res.json({
    message: 'Welcome Pro VIP!',
    email: req.strictProxy.email,
  });
});
```

| What you write | Who is allowed in? |
| --- | --- |
| `gk.auth()` | Anyone connected to your StrictProxy VPN (unless you set `requiredTier` in `init`). |
| `gk.auth('standard')` | Connected to StrictProxy **AND** has a `standard` or `pro` plan. |
| `gk.auth('pro')` | Connected to StrictProxy **AND** has a `pro` plan. |

> **How do users open a paid-plan website in their browser?**
> Publish the website URL in **`/admin#links`**. When a user taps your link in the StrictProxy app, it opens with a tiny one-time pass (`?sp_ticket=...`). Gatekeeper automatically checks it and saves a safe cookie so every other page click on your site keeps working!

---

## Running Behind Nginx, Caddy, Traefik, or Cloudflare?

If a reverse proxy sits in front of your Node app, your app sees `127.0.0.1` instead of the visitor's real IP. Tell Gatekeeper to read the forwarded IP safely:

```js
const gk = Gatekeeper.init({
  trustForwardedFor: true,
  trustedProxyHops: 1, // 1 if you have ONE proxy (e.g. Caddy or Nginx) in front of your app
});
```

> **Why `trustedProxyHops: 1`?** So nobody can fake their IP address by sending a bogus `X-Forwarded-For` header.

---

## Want to Redirect Blocked Visitors Instead of Showing JSON?

By default, blocked visitors get a clean JSON error. If you prefer sending them to a "Download StrictProxy" page:

```js
const gk = Gatekeeper.init({
  denyResponse: { redirectUrl: 'https://yoursite.com/get-strict-proxy' },
});
```

---

## Recipes by Framework & Stack

> **Important rule for frontend apps (React, Vue, Svelte, Vite):**
> Never put security checks only in browser JavaScript — anyone can inspect or bypass browser code. Always put Gatekeeper on your **backend server** (Express, Next.js, Fastify, Hono, NestJS, etc.) or in front of your built static site.

### 1. Express (Website + API)

The simplest setup — protect your whole app or only specific routes:

```js
import express from 'express';
import { Gatekeeper } from '@strict-proxy/gatekeeper';

const app = express();
const gk = Gatekeeper.init({
  trustForwardedFor: true,
  trustedProxyHops: 1,
});

// Public page — anyone can see this even without StrictProxy
app.get('/public', (req, res) => {
  res.send('Download StrictProxy to unlock the members area!');
});

// Protected routes — StrictProxy required
app.get('/private', gk.auth(), (req, res) => {
  res.send('Only StrictProxy users can see this!');
});

app.get('/api/pro-data', gk.auth('pro'), (req, res) => {
  res.json({ secret: 42, user: req.strictProxy });
});

app.listen(4000);
```

---

### 2. React / Vite SPA + Express Backend (Recommended Full-Stack Pattern)

If you built a **React**, **Vue**, or **Vite** frontend, you have two clean choices:

#### Option A — Lock the entire React app + API (simplest!)
Serve your `dist/` folder from Express behind `gk.auth()`. Visitors not on StrictProxy cannot even load the React app:

```js
// server.js
import path from 'node:path';
import express from 'express';
import { Gatekeeper } from '@strict-proxy/gatekeeper';

const app = express();
const gk = Gatekeeper.init({
  requiredTier: 'standard', // omit for proxy-only
  trustForwardedFor: true,
  trustedProxyHops: 1,
  // Optional: send non-proxy visitors to a nice download page
  denyResponse: { redirectUrl: 'https://yoursite.com/get-strict-proxy' },
});

// Protect BOTH the React files and the API
app.use(gk.auth());

app.get('/api/me', (req, res) => {
  res.json({ user: req.strictProxy });
});

// Serve your built React / Vite app
app.use(express.static(path.resolve('dist')));
app.get('*', (_req, res) => {
  res.sendFile(path.resolve('dist/index.html'));
});

app.listen(4000);
```

#### Option B — Public React UI calling a Gatekeeper-protected API
Keep your React landing page public, and protect `/api/*`. Always pass `credentials: 'include'` so the browser sends the `sp_entitlement` cookie saved by Gatekeeper:

```tsx
// App.tsx (React)
import { useEffect, useState } from 'react';

export function App() {
  const [status, setStatus] = useState<'loading' | 'ok' | 'blocked'>('loading');
  const [message, setMessage] = useState('');
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    // Forward ?sp_ticket=... if the user just arrived from the StrictProxy app
    const ticket = new URLSearchParams(window.location.search).get('sp_ticket');
    const url = ticket
      ? `/api/dashboard?sp_ticket=${encodeURIComponent(ticket)}`
      : '/api/dashboard';

    fetch(url, { credentials: 'include' })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) {
          setStatus('blocked');
          setMessage(body.hint || body.error || 'Connect to StrictProxy to continue.');
          return;
        }
        setData(body);
        setStatus('ok');
      })
      .catch(() => {
        setStatus('blocked');
        setMessage('Could not reach the server.');
      });
  }, []);

  if (status === 'loading') return <p>Checking StrictProxy connection...</p>;
  if (status === 'blocked') {
    return (
      <div>
        <h1>StrictProxy Required</h1>
        <p>{message}</p>
      </div>
    );
  }
  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}
```

> **Separate API domain?** If your React app is on `app.example.com` and your API is on `api.example.com`, enable CORS with `credentials: true` and an explicit origin (`origin: 'https://app.example.com'`, never `*`).

---

### 3. Next.js (App Router — API Routes & Server Components)

Create one shared Gatekeeper file and reuse it across API routes:

```ts
// lib/gatekeeper.ts
import { Gatekeeper } from '@strict-proxy/gatekeeper';

export const gk = Gatekeeper.init({
  requiredTier: 'standard', // omit for proxy-only
  trustForwardedFor: true,
  trustedProxyHops: 1,
});
```

```ts
// app/api/secret/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { gk } from '@/lib/gatekeeper';

export const runtime = 'nodejs'; // uses Node's built-in Ed25519 crypto

export async function GET(request: NextRequest) {
  const result = await gk.verifyRequest(request);

  if (!result.allowed) {
    if (result.redirectUrl) return NextResponse.redirect(result.redirectUrl, 302);
    return NextResponse.json(result.body, { status: result.status });
  }

  const res = NextResponse.json({ ok: true, user: result.user });
  if (result.setCookie) res.headers.append('Set-Cookie', result.setCookie);
  return res;
}
```

```tsx
// app/members/page.tsx (Next.js Server Component)
import { headers } from 'next/headers';
import { gk } from '@/lib/gatekeeper';

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const hdrs = await headers();
  const query = await searchParams;
  const result = await gk.authorize({
    headers: hdrs,
    query,
    secure: hdrs.get('x-forwarded-proto') === 'https',
  });

  if (!result.allowed) {
    return (
      <main>
        <h1>StrictProxy Required</h1>
        <p>{String(result.body.hint ?? result.body.error)}</p>
      </main>
    );
  }

  return <main>Welcome {result.user?.email ?? 'StrictProxy member'}!</main>;
}
```

---

### 4. Fastify

```ts
import Fastify from 'fastify';
import { Gatekeeper } from '@strict-proxy/gatekeeper';

const app = Fastify();
const gk = Gatekeeper.init({
  requiredTier: 'standard', // omit for proxy-only
  trustForwardedFor: true,
  trustedProxyHops: 1,
});

app.addHook('onRequest', async (request, reply) => {
  const result = await gk.authorize({
    ip: request.socket.remoteAddress,
    headers: request.headers,
    query: request.query as Record<string, unknown>,
    secure: request.protocol === 'https',
  });

  if (!result.allowed) {
    if (result.redirectUrl) return reply.redirect(result.redirectUrl, 302);
    return reply.code(result.status).send(result.body);
  }
  if (result.setCookie) reply.header('Set-Cookie', result.setCookie);
  (request as any).strictProxy = result.user;
});

app.get('/', async (request) => ({
  ok: true,
  user: (request as any).strictProxy,
}));

app.listen({ port: 4000, host: '0.0.0.0' });
```

---

### 5. Hono (Node.js / Bun / Deno)

```ts
import { Hono } from 'hono';
import { Gatekeeper } from '@strict-proxy/gatekeeper';

const app = new Hono();
const gk = Gatekeeper.init({ trustForwardedFor: true, trustedProxyHops: 1 });

app.use('/private/*', async (c, next) => {
  const result = await gk.verifyRequest(c.req.raw, 'standard');

  if (!result.allowed) {
    if (result.redirectUrl) return c.redirect(result.redirectUrl, 302);
    return c.json(result.body, result.status as 401 | 403);
  }
  if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true });
  c.set('strictProxy', result.user);
  await next();
});

app.get('/private/hello', (c) => c.json({ ok: true, user: c.get('strictProxy') }));
```

---

### 6. NestJS (Guard)

```ts
// strict-proxy.guard.ts
import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Gatekeeper, type SubscriptionTier } from '@strict-proxy/gatekeeper';

const gk = Gatekeeper.init({ trustForwardedFor: true, trustedProxyHops: 1 });

@Injectable()
export class StrictProxyGuard implements CanActivate {
  constructor(private readonly tier?: SubscriptionTier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const result = await gk.verify(req, this.tier);

    if (!result.allowed) {
      throw new HttpException(result.body, result.status);
    }
    if (result.setCookie) res.append('Set-Cookie', result.setCookie);
    req.strictProxy = result.user;
    return true;
  }
}

// Usage on any controller or route:
// @UseGuards(new StrictProxyGuard('pro'))
```

---

### 7. Koa

```ts
import Koa from 'koa';
import { Gatekeeper } from '@strict-proxy/gatekeeper';

const app = new Koa();
const gk = Gatekeeper.init({ trustForwardedFor: true, trustedProxyHops: 1 });

app.use(async (ctx, next) => {
  const result = await gk.authorize({
    ip: ctx.req.socket.remoteAddress,
    headers: ctx.headers,
    query: ctx.query,
    secure: ctx.secure,
  });

  if (!result.allowed) {
    if (result.redirectUrl) {
      ctx.redirect(result.redirectUrl);
      return;
    }
    ctx.status = result.status;
    ctx.body = result.body;
    return;
  }
  if (result.setCookie) ctx.append('Set-Cookie', result.setCookie);
  ctx.state.strictProxy = result.user;
  await next();
});
```

---

### 8. Plain Node.js `http` (No Framework at All)

```js
import http from 'node:http';
import { Gatekeeper } from '@strict-proxy/gatekeeper';

const gk = Gatekeeper.init({ trustForwardedFor: true, trustedProxyHops: 1 });

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const result = await gk.authorize({
    ip: req.socket.remoteAddress,
    headers: req.headers,
    query: url.searchParams,
    secure: req.headers['x-forwarded-proto'] === 'https',
  });

  if (!result.allowed) {
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
    return;
  }
  if (result.setCookie) res.setHeader('Set-Cookie', result.setCookie);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, user: result.user }));
}).listen(4000);
```

---

## What Each Block Message Means

| Status | Code | Plain-English Meaning |
| --- | --- | --- |
| `403` | `GATEKEEPER_DENIED` | Visitor is NOT connected to your StrictProxy VPN (or your controller could not be reached). |
| `401` | `GATEKEEPER_ENTITLEMENT_REQUIRED` | This page needs a paid plan, and no pass/ticket was sent. |
| `401` | `GATEKEEPER_ENTITLEMENT_INVALID` | The pass/ticket expired or was tampered with. Opening the link again from the app gives a fresh one. |
| `403` | `GATEKEEPER_TIER_INSUFFICIENT` | Visitor is on a lower plan (for example, `standard` trying to open a `pro` page). |

---

## Troubleshooting (Common Questions)

- **I am connected to StrictProxy, why am I still blocked?**
  1. Check `/admin#links` -> **Active exit IPs**. Make sure at least one proxy node is **Online**.
  2. If your website is behind Nginx, Caddy, or Cloudflare, make sure you enabled `trustForwardedFor: true` and `trustedProxyHops: 1`.
- **Do I have to pass `publicKey`?**
  - Putting `STRICT_PROXY_PUBLIC_KEY_PEM` in `.env` is best for production (fast and extra secure). If your controller uses `https://` and you leave `publicKey` out, Gatekeeper will fetch it once automatically.
- **Does Gatekeeper slow down my website?**
  - No! It caches your proxy IP list for 5 minutes and checks user passes completely offline (no network call per visitor).

---

## All Options (Reference)

```ts
const gk = Gatekeeper.init({
  controllerUrl: 'https://proxy.example.com', // or env STRICT_PROXY_CONTROLLER_URL
  publicKey: '-----BEGIN PUBLIC KEY-----...', // or env STRICT_PROXY_PUBLIC_KEY_PEM
  publicKeys: { primary: '...' },             // optional: use when rotating multiple keys
  requiredTier: 'standard',                   // optional: 'free' | 'standard' | 'pro'
  trustForwardedFor: false,                   // set true behind Nginx/Caddy/Cloudflare
  trustedProxyHops: 1,                        // number of proxies in front of your app
  failureMode: 'closed',                      // 'closed' (safe default) or 'open'
  cacheTtlSeconds: 300,                       // how often to refresh proxy IP list
  setCookieFromQuery: true,                   // auto-save ?sp_ticket= into an HttpOnly cookie
  denyResponse: { redirectUrl: '...' },       // or { status: 403, body: { error: '...' } }
});
```

### Methods
- `Gatekeeper.init(options?)` — creates the bouncer.
- `gk.auth(tierOrOptions?)` — Express middleware.
- `gk.verify(req, tierOrOptions?)` — checks an Express/Node request, returns `{ allowed, user, setCookie, ... }`.
- `gk.verifyRequest(request, tierOrOptions?)` — checks a Web Standard `Request` (Next.js / Hono / Fetch).
- `gk.authorize({ ip, headers, query, secure }, tierOrOptions?)` — works anywhere.
- `gk.verifyToken(token)` — checks an `sp1.*` pass string offline.
- `gk.refresh()` — refreshes the proxy IP list immediately.

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

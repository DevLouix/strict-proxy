/**
 * Gatekeeper Browser Plan-Pass Handoff (RFC 9126 PAR + Direct Registered-Origin `/pass`).
 *
 * Solves the direct-URL / bookmark gap for plan-gated websites:
 *
 * 1. Server-to-Server PAR (`POST /api/v1/gatekeeper/pass-session`, Bearer `sp_gk_...`):
 *    The gated site asks the controller to open a 5-minute single-use pass session
 *    for a verified return URL, then redirects the visitor to the returned `handoffUrl`
 *    (`https://<controller>/pass/<sessionId>`). Zero secrets ever touch the browser URL.
 *
 * 2. Direct Registered-Origin Redirect (`GET /pass?site=sp_gk_<8hex>&return=/wallet`):
 *    For sites configured with a static redirect URL, looks up the active site key by
 *    prefix and locks the return destination strictly to the key's registered `siteUrl`
 *    origin — completely preventing open-redirect abuse.
 *
 * 3. Zero-Click SSO Cookie (`sp_pass_session`):
 *    Once a user signs in once on `/pass`, subsequent pass handoffs from any gated site
 *    verify their live subscription in Postgres and immediately 302-redirect back with a
 *    fresh Ed25519-signed `?sp_ticket=sp1...` without showing the login form again.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import { users } from '../db/schema.js';
import { asyncHandler } from '../middleware.js';
import { mintEntitlementToken } from '../services/entitlements.js';
import { rateLimit } from '../services/rate-limit.js';
import {
  findActiveGatekeeperKeyByPrefix,
  sanitizeReturnPath,
  verifyGatekeeperKey,
} from '../services/gatekeeper-keys.js';

interface Ctx {
  db: Db;
  cfg: ControllerConfig;
  redis: Redis;
}

type PassRequiredTier = 'standard' | 'pro';

interface PassSessionRecord {
  sessionId: string;
  csrfToken: string;
  siteId: string;
  siteName: string;
  returnUrl: string;
  requiredTier: PassRequiredTier | null;
  createdAt: string;
}

const PASS_SESSION_TTL_SECONDS = 300;
const PASS_COOKIE_NAME = 'sp_pass_session';
const PASS_COOKIE_TTL_SECONDS = 7 * 24 * 3600;
const PASS_JWT_AUDIENCE = 'strict-proxy-pass';
const SESSION_ID_RE = /^[A-Za-z0-9_-]{24,64}$/;
const TIER_RANK: Record<string, number> = { free: 0, standard: 1, pro: 2 };

function redisKey(sessionId: string): string {
  return `gk:pass:${sessionId}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseRequiredTier(raw: unknown): PassRequiredTier | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (s === 'standard' || s === 'pro') return s;
  return null;
}

function tierSatisfies(actual: string, required: PassRequiredTier | null): boolean {
  if (!required) return true;
  return (TIER_RANK[actual] ?? 0) >= (TIER_RANK[required] ?? 99);
}

function extractPresentedKey(req: Request): string | undefined {
  const auth = req.header('authorization');
  if (auth && /^bearer\s+/i.test(auth)) {
    const token = auth.replace(/^bearer\s+/i, '').trim();
    if (token) return token;
  }
  const direct = req.header('x-gatekeeper-key') ?? req.header('x-api-key');
  return direct?.trim() || undefined;
}

function requestClientIp(req: Request): string | null {
  const raw = req.ip || req.socket?.remoteAddress || null;
  if (!raw) return null;
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.header('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return undefined;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

function signPassCookie(cfg: ControllerConfig, userId: string): string {
  return jwt.sign({ sub: userId }, cfg.jwtSecret, {
    issuer: cfg.jwtIssuer,
    audience: PASS_JWT_AUDIENCE,
    expiresIn: PASS_COOKIE_TTL_SECONDS,
    algorithm: 'HS256',
  });
}

function verifyPassCookie(cfg: ControllerConfig, token: string | undefined): string | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, cfg.jwtSecret, {
      issuer: cfg.jwtIssuer,
      audience: PASS_JWT_AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof decoded === 'object' && decoded && typeof decoded.sub === 'string') {
      return decoded.sub;
    }
    return null;
  } catch {
    return null;
  }
}

function isHttpsRequest(req: Request, cfg: ControllerConfig): boolean {
  const proto = req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return req.secure || proto === 'https' || cfg.publicAppUrl.startsWith('https://');
}

function setPassCookie(req: Request, res: Response, cfg: ControllerConfig, userId: string): void {
  const token = signPassCookie(cfg, userId);
  const parts = [
    `${PASS_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/pass',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${PASS_COOKIE_TTL_SECONDS}`,
  ];
  if (isHttpsRequest(req, cfg)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearPassCookie(req: Request, res: Response, cfg: ControllerConfig): void {
  const parts = [
    `${PASS_COOKIE_NAME}=`,
    'Path=/pass',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isHttpsRequest(req, cfg)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function appendTicketToReturnUrl(returnUrl: string, ticket: string): string {
  const url = new URL(returnUrl);
  url.searchParams.set('sp_ticket', ticket);
  return url.toString();
}

function resolvePublicBaseUrl(req: Request, cfg: ControllerConfig): string {
  const configured = cfg.publicAppUrl?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const proto = req.header('x-forwarded-proto')?.split(',')[0]?.trim() || (req.secure ? 'https' : 'http');
  const host = req.header('host') || '127.0.0.1';
  return `${proto}://${host}`;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function validateParReturnUrl(
  rawReturnUrl: unknown,
  rawReturnPath: unknown,
  registeredSiteUrl: string | null,
): string {
  if (typeof rawReturnUrl === 'string' && rawReturnUrl.trim()) {
    let parsed: URL;
    try {
      parsed = new URL(rawReturnUrl.trim());
    } catch {
      throw new Error('returnUrl must be a valid URL');
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
      throw new Error('returnUrl must use https:// (or http://localhost for local development)');
    }
    if (parsed.username || parsed.password) {
      throw new Error('returnUrl must not contain credentials');
    }
    if (registeredSiteUrl && parsed.origin !== registeredSiteUrl) {
      throw new Error(`returnUrl origin (${parsed.origin}) does not match registered siteUrl (${registeredSiteUrl})`);
    }
    parsed.searchParams.delete('sp_ticket');
    return parsed.toString();
  }

  if (registeredSiteUrl) {
    const safePath = sanitizeReturnPath(rawReturnPath);
    const resolved = new URL(safePath, registeredSiteUrl);
    if (resolved.origin !== registeredSiteUrl) {
      throw new Error('returnPath resolved outside registered siteUrl');
    }
    return resolved.toString();
  }

  throw new Error('returnUrl is required when the site key has no registered siteUrl');
}

function renderPassHtml(opts: {
  title: string;
  siteName: string;
  returnHost: string;
  requiredTier: PassRequiredTier | null;
  sessionId?: string;
  csrfToken?: string;
  email?: string;
  error?: string;
  signedInEmail?: string;
  signedInTier?: string;
  fatalMessage?: string;
}): string {
  const tierLabel = opts.requiredTier ? opts.requiredTier.toUpperCase() : 'STRICTPROXY';
  const siteEsc = escapeHtml(opts.siteName);
  const hostEsc = escapeHtml(opts.returnHost);
  const errBlock = opts.error
    ? `<div class="alert err">${escapeHtml(opts.error)}</div>`
    : '';

  let bodyHtml = '';
  if (opts.fatalMessage) {
    bodyHtml = `
      <div class="alert err">${escapeHtml(opts.fatalMessage)}</div>
      <p class="muted">Return to the site and try again, or open the link from the StrictProxy app.</p>
    `;
  } else if (opts.signedInEmail) {
    bodyHtml = `
      <div class="alert warn">
        Signed in as <strong>${escapeHtml(opts.signedInEmail)}</strong>
        (current plan: <strong>${escapeHtml((opts.signedInTier ?? 'free').toUpperCase())}</strong>).
        <strong>${siteEsc}</strong> requires the <strong>${escapeHtml(tierLabel)}</strong> plan.
      </div>
      <p class="muted">Upgrade your plan in the StrictProxy app, or sign in with another StrictProxy account.</p>
      <form method="post" action="/pass/logout">
        <input type="hidden" name="sessionId" value="${escapeHtml(opts.sessionId ?? '')}" />
        <button class="btn secondary" type="submit">Switch account</button>
      </form>
    `;
  } else {
    bodyHtml = `
      ${errBlock}
      <form method="post" action="/pass/${escapeHtml(opts.sessionId ?? '')}">
        <input type="hidden" name="csrf" value="${escapeHtml(opts.csrfToken ?? '')}" />
        <label class="field">
          <span>StrictProxy email</span>
          <input name="email" type="email" required autocomplete="username" value="${escapeHtml(opts.email ?? '')}" placeholder="you@example.com" />
        </label>
        <label class="field">
          <span>Password</span>
          <input name="password" type="password" required autocomplete="current-password" placeholder="••••••••••" />
        </label>
        <button class="btn" type="submit">Continue to ${siteEsc}</button>
      </form>
      <p class="muted foot">You will be redirected to <code>${hostEsc}</code> with a short-lived signed pass. Future visits from this browser skip this step automatically.</p>
    `;
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${escapeHtml(opts.title)} · StrictProxy</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px;
      background: #0b0e14; color: #e6edf3; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .card {
      width: 100%; max-width: 420px; background: #121722; border: 1px solid #242d3d;
      border-radius: 14px; padding: 26px 24px; box-shadow: 0 20px 50px rgba(0,0,0,.45);
    }
    .kicker { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #7aa2f7; font-weight: 600; margin-bottom: 6px; }
    h1 { margin: 0 0 6px; font-size: 21px; line-height: 1.25; }
    .sub { margin: 0 0 18px; color: #9aa7b8; font-size: 14px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; background: #1d273b; color: #9ec5fe; font-size: 12px; font-weight: 600; }
    .field { display: block; margin-bottom: 14px; }
    .field span { display: block; font-size: 13px; color: #c4cfdc; margin-bottom: 5px; }
    .field input {
      width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #2b364a;
      background: #0d111a; color: #f0f6fc; font-size: 15px;
    }
    .field input:focus { outline: 2px solid #3b82f6; border-color: #3b82f6; }
    .btn {
      width: 100%; padding: 11px 14px; border: 0; border-radius: 8px; cursor: pointer;
      background: #2563eb; color: #fff; font-weight: 600; font-size: 15px; margin-top: 4px;
    }
    .btn:hover { background: #1d4ed8; }
    .btn.secondary { background: #1f2937; color: #e5e7eb; border: 1px solid #374151; }
    .alert { padding: 10px 12px; border-radius: 8px; font-size: 13.5px; margin-bottom: 14px; }
    .alert.err { background: rgba(239,68,68,.14); border: 1px solid rgba(239,68,68,.4); color: #fca5a5; }
    .alert.warn { background: rgba(245,158,11,.14); border: 1px solid rgba(245,158,11,.4); color: #fcd34d; }
    .muted { color: #8b98a9; font-size: 13px; }
    .foot { margin-top: 14px; margin-bottom: 0; }
    code { color: #cbd5e1; font-size: 12.5px; }
  </style>
</head>
<body>
  <main class="card">
    <div class="kicker">StrictProxy Access Pass</div>
    <h1>${siteEsc}</h1>
    <p class="sub">Sign in to verify your <span class="badge">${escapeHtml(tierLabel)}</span> access pass.</p>
    ${bodyHtml}
  </main>
</body>
</html>`;
}

export function buildPassHandoffRouter(ctx: Ctx): Router {
  const router = Router();
  const urlencoded = express.urlencoded({ extended: false, limit: '16kb' });

  async function saveSession(record: PassSessionRecord): Promise<void> {
    await ctx.redis.set(
      redisKey(record.sessionId),
      JSON.stringify(record),
      'EX',
      PASS_SESSION_TTL_SECONDS,
    );
  }

  async function loadSession(sessionId: string): Promise<PassSessionRecord | null> {
    if (!SESSION_ID_RE.test(sessionId)) return null;
    const raw = await ctx.redis.get(redisKey(sessionId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PassSessionRecord;
    } catch {
      return null;
    }
  }

  async function issuePassOrDeny(
    req: Request,
    res: Response,
    session: PassSessionRecord,
    userId: string,
  ): Promise<boolean> {
    const [account] = await ctx.db
      .select({ email: users.email, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!account || account.disabledAt) {
      clearPassCookie(req, res, ctx.cfg);
      return false;
    }

    let minted;
    try {
      minted = await mintEntitlementToken(ctx.db, ctx.cfg, userId);
    } catch {
      clearPassCookie(req, res, ctx.cfg);
      return false;
    }

    if (!tierSatisfies(minted.tier, session.requiredTier)) {
      const returnHost = new URL(session.returnUrl).host;
      res.status(403).type('html').send(
        renderPassHtml({
          title: 'Plan required',
          siteName: session.siteName,
          returnHost,
          requiredTier: session.requiredTier,
          sessionId: session.sessionId,
          signedInEmail: account.email,
          signedInTier: minted.tier,
        }),
      );
      return true;
    }

    // Consume the one-time pass session and redirect back with the signed ticket.
    await ctx.redis.del(redisKey(session.sessionId)).catch(() => undefined);
    res.redirect(302, appendTicketToReturnUrl(session.returnUrl, minted.token));
    return true;
  }

  // -- 1. Server-to-Server PAR (`POST /api/v1/gatekeeper/pass-session`) -------
  router.post(
    '/api/v1/gatekeeper/pass-session',
    asyncHandler(async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const presented = extractPresentedKey(req);
      const site = await verifyGatekeeperKey(ctx.db, presented, requestClientIp(req));
      if (!site) {
        res.status(401).json({
          error: 'Invalid, revoked, or expired Gatekeeper site key.',
          code: 'GATEKEEPER_KEY_INVALID',
        });
        return;
      }

      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      let returnUrl: string;
      try {
        returnUrl = validateParReturnUrl(body.returnUrl, body.returnPath, site.siteUrl);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message, code: 'VALIDATION_ERROR' });
        return;
      }

      const requiredTier = parseRequiredTier(body.requiredTier);
      if (body.requiredTier !== undefined && body.requiredTier !== null && body.requiredTier !== '' && !requiredTier) {
        res.status(400).json({ error: 'requiredTier must be standard or pro', code: 'VALIDATION_ERROR' });
        return;
      }

      const sessionId = randomBytes(24).toString('base64url');
      const csrfToken = randomBytes(18).toString('base64url');
      await saveSession({
        sessionId,
        csrfToken,
        siteId: site.id,
        siteName: site.name,
        returnUrl,
        requiredTier,
        createdAt: new Date().toISOString(),
      });

      const baseUrl = resolvePublicBaseUrl(req, ctx.cfg);
      res.status(201).json({
        sessionId,
        handoffUrl: `${baseUrl}/pass/${sessionId}`,
        expiresIn: PASS_SESSION_TTL_SECONDS,
      });
    }),
  );

  // -- 2. Direct registered-origin browser redirect (`GET /pass?site=...`) ----
  router.get(
    '/pass',
    asyncHandler(async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const sitePrefix = typeof req.query.site === 'string' ? req.query.site.trim() : '';
      const site = await findActiveGatekeeperKeyByPrefix(ctx.db, sitePrefix);
      if (!site || !site.siteUrl) {
        res.status(400).type('html').send(
          renderPassHtml({
            title: 'Invalid pass link',
            siteName: 'StrictProxy',
            returnHost: '',
            requiredTier: null,
            fatalMessage:
              'This site pass link is missing a valid registered site key prefix (?site=sp_gk_...) or the key has no Site URL configured in Admin -> Links -> Key Factory.',
          }),
        );
        return;
      }

      const safePath = sanitizeReturnPath(req.query.return);
      const returnUrl = new URL(safePath, site.siteUrl).toString();
      const requiredTier = parseRequiredTier(req.query.tier ?? req.query.requiredTier);

      const sessionId = randomBytes(24).toString('base64url');
      const csrfToken = randomBytes(18).toString('base64url');
      const session: PassSessionRecord = {
        sessionId,
        csrfToken,
        siteId: site.id,
        siteName: site.name,
        returnUrl,
        requiredTier,
        createdAt: new Date().toISOString(),
      };
      await saveSession(session);

      // Zero-click SSO if browser already holds a valid pass cookie.
      const existingUserId = verifyPassCookie(ctx.cfg, readCookie(req, PASS_COOKIE_NAME));
      if (existingUserId) {
        const handled = await issuePassOrDeny(req, res, session, existingUserId);
        if (handled) return;
      }

      res.redirect(302, `/pass/${sessionId}`);
    }),
  );

  // -- 3. Hosted Pass Page (`GET /pass/:sessionId`) ---------------------------
  router.get(
    '/pass/:sessionId',
    asyncHandler(async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const session = await loadSession(String(req.params.sessionId ?? ''));
      if (!session) {
        res.status(410).type('html').send(
          renderPassHtml({
            title: 'Pass session expired',
            siteName: 'StrictProxy',
            returnHost: '',
            requiredTier: null,
            fatalMessage: 'This access pass request has expired or was already used.',
          }),
        );
        return;
      }

      const existingUserId = verifyPassCookie(ctx.cfg, readCookie(req, PASS_COOKIE_NAME));
      if (existingUserId) {
        const handled = await issuePassOrDeny(req, res, session, existingUserId);
        if (handled) return;
      }

      const returnHost = new URL(session.returnUrl).host;
      res.status(200).type('html').send(
        renderPassHtml({
          title: `Sign in to ${session.siteName}`,
          siteName: session.siteName,
          returnHost,
          requiredTier: session.requiredTier,
          sessionId: session.sessionId,
          csrfToken: session.csrfToken,
        }),
      );
    }),
  );

  // -- 4. Switch Account (`POST /pass/logout`) --------------------------------
  router.post(
    '/pass/logout',
    urlencoded,
    asyncHandler(async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      clearPassCookie(req, res, ctx.cfg);
      const sid = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
      if (SESSION_ID_RE.test(sid)) {
        res.redirect(302, `/pass/${sid}`);
        return;
      }
      res.redirect(302, '/');
    }),
  );

  // -- 5. Sign-In & Mint Ticket (`POST /pass/:sessionId`) ---------------------
  router.post(
    '/pass/:sessionId',
    urlencoded,
    rateLimit(ctx.cfg, {
      bucket: 'pass.login',
      maxAttempts: ctx.cfg.rateLimitMaxAttempts,
      windowSeconds: ctx.cfg.rateLimitWindowSeconds,
    }),
    asyncHandler(async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const session = await loadSession(String(req.params.sessionId ?? ''));
      if (!session) {
        res.status(410).type('html').send(
          renderPassHtml({
            title: 'Pass session expired',
            siteName: 'StrictProxy',
            returnHost: '',
            requiredTier: null,
            fatalMessage: 'This access pass request has expired or was already used.',
          }),
        );
        return;
      }

      const returnHost = new URL(session.returnUrl).host;
      const presentedCsrf = typeof req.body?.csrf === 'string' ? req.body.csrf : '';
      const a = Buffer.from(presentedCsrf, 'utf8');
      const b = Buffer.from(session.csrfToken, 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        res.status(403).type('html').send(
          renderPassHtml({
            title: `Sign in to ${session.siteName}`,
            siteName: session.siteName,
            returnHost,
            requiredTier: session.requiredTier,
            sessionId: session.sessionId,
            csrfToken: session.csrfToken,
            error: 'Session verification failed. Please submit the form again.',
          }),
        );
        return;
      }

      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!email || !password) {
        res.status(400).type('html').send(
          renderPassHtml({
            title: `Sign in to ${session.siteName}`,
            siteName: session.siteName,
            returnHost,
            requiredTier: session.requiredTier,
            sessionId: session.sessionId,
            csrfToken: session.csrfToken,
            email,
            error: 'Email and password are required.',
          }),
        );
        return;
      }

      const [user] = await ctx.db
        .select({ id: users.id, passwordHash: users.passwordHash, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      const validPassword = user && !user.disabledAt
        ? await bcrypt.compare(password, user.passwordHash)
        : false;

      if (!user || !validPassword) {
        res.status(401).type('html').send(
          renderPassHtml({
            title: `Sign in to ${session.siteName}`,
            siteName: session.siteName,
            returnHost,
            requiredTier: session.requiredTier,
            sessionId: session.sessionId,
            csrfToken: session.csrfToken,
            email,
            error: 'Invalid email or password.',
          }),
        );
        return;
      }

      setPassCookie(req, res, ctx.cfg, user.id);
      await issuePassOrDeny(req, res, session, user.id);
    }),
  );

  return router;
}

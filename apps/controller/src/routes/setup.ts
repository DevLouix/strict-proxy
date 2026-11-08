/**
 * First-run bootstrap for the platform root administrator.
 *
 * The page is a one-time door, not a feature: the exists-check runs on every
 * request and is evaluated before anything else this router does. As soon as an
 * administrator exists, `/setup` falls through to the ordinary 404 instead of
 * answering with a "setup is disabled" screen — there is nothing to discover or
 * probe, and no state to leak.
 *
 * Security properties:
 *   - The route creates an account only while zero administrators exist, and
 *     the check and the insert share one transaction serialized by an advisory
 *     lock. Five concurrent submissions produce exactly one root admin.
 *   - The page is self-contained HTML with no JavaScript and a CSP that allows
 *     only inline styles and a same-origin form post.
 *   - Passwords are bcrypt-hashed at cost 12, the same as every other account.
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { subscriptions, users } from '../db/schema.js';

/** Privileged first account: longer than the 10-character public register floor. */
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;
const BCRYPT_ROUNDS = 12;

type SetupOutcome =
  | { kind: 'created'; user: { id: string; email: string } }
  | { kind: 'admin-exists' }
  | { kind: 'email-taken' };

/** True when any administrator account exists. Cheap enough to run per request. */
export async function platformRootAdminExists(db: Db): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).limit(1);
  return row !== undefined;
}

/**
 * Creates the root admin if — and only if — none exists.
 *
 * The advisory lock is transaction-scoped and serializes concurrent bootstrap
 * attempts, which a plain "SELECT then INSERT" would not: two submissions could
 * both see zero admins and both insert. The lock is released on commit or
 * rollback, so a crashed request cannot wedge setup.
 */
async function createRootAdmin(db: Db, email: string, password: string): Promise<SetupOutcome> {
  // Hash before opening the transaction so the lock is held for one insert, not
  // for the ~250ms bcrypt cost.
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('strict-proxy:root-admin'))`);

    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).limit(1);
    if (existing) return { kind: 'admin-exists' } as const;

    const [created] = await tx
      .insert(users)
      .values({ email, passwordHash, role: 'admin' })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id, email: users.email });

    // A row already holding this address is not promoted implicitly: setup must
    // not become a way to escalate an account registered before bootstrap.
    if (!created) return { kind: 'email-taken' } as const;

    // Match the seeded root account, so the dashboard is not empty on first
    // login and operator tooling can assume the root admin has a paid tier.
    await tx
      .insert(subscriptions)
      .values({ userId: created.id, tier: 'pro', status: 'active' })
      .onConflictDoNothing({ target: subscriptions.userId });

    return { kind: 'created', user: created } as const;
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The one-time page. No scripts, no external assets, no inline data. */
function renderPage(options: { error?: string; email?: string } = {}): string {
  const email = escapeHtml(options.email ?? '');
  const error = options.error
    ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Set up StrictProxy</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
        background: #0b0d12; color: #e7eaf0;
        font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .card { width: 100%; max-width: 420px; padding: 28px; border-radius: 14px;
        background: #141821; border: 1px solid #232a37; }
      h1 { margin: 0 0 6px; font-size: 20px; }
      .sub { margin: 0 0 22px; color: #99a2b3; font-size: 13px; }
      label { display: block; margin-bottom: 14px; }
      label span { display: block; margin-bottom: 6px; font-size: 13px; color: #b7c0d1; }
      input { width: 100%; padding: 10px 12px; border-radius: 9px; border: 1px solid #2c3444;
        background: #0e1219; color: #e7eaf0; font: inherit; }
      input:focus { outline: 2px solid #4c7dff; outline-offset: 1px; }
      button { width: 100%; margin-top: 6px; padding: 11px 14px; border: 0; border-radius: 9px;
        background: #4c7dff; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
      button:hover { background: #3f6ae6; }
      .error { margin: 0 0 14px; padding: 9px 11px; border-radius: 8px;
        background: #2a1418; border: 1px solid #5b2029; color: #ffb4b4; font-size: 13px; }
      .foot { margin: 18px 0 0; color: #6f7889; font-size: 12px; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Set up StrictProxy</h1>
      <p class="sub">Create the platform root administrator. This page exists only until one does.</p>
      ${error}
      <form method="post" action="/setup" autocomplete="off">
        <label><span>Email</span>
          <input type="email" name="email" value="${email}" required maxlength="${MAX_EMAIL_LENGTH}" autocomplete="username" />
        </label>
        <label><span>Password</span>
          <input type="password" name="password" required minlength="${MIN_PASSWORD_LENGTH}" maxlength="${MAX_PASSWORD_LENGTH}" autocomplete="new-password" />
        </label>
        <label><span>Confirm password</span>
          <input type="password" name="confirm" required minlength="${MIN_PASSWORD_LENGTH}" maxlength="${MAX_PASSWORD_LENGTH}" autocomplete="new-password" />
        </label>
        <button type="submit">Create root admin</button>
      </form>
      <p class="foot">After this page returns 404, sign in at /admin.</p>
    </main>
  </body>
</html>`;
}

function sendPage(res: Response, status: number, options: { error?: string; email?: string } = {}): void {
  res.status(status);
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.type('html').send(renderPage(options));
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function buildSetupRouter(ctx: { db: Db }): Router {
  const { db } = ctx;
  const router = Router();
  const formBody = express.urlencoded({ extended: false, limit: '16kb' });

  /**
   * Runs `handler` only while no administrator exists; otherwise passes the
   * request on untouched so the normal 404 answers it.
   */
  function setupOnly(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
    return (req: Request, res: Response, next: NextFunction): void => {
      void (async () => {
        if (await platformRootAdminExists(db)) {
          next();
          return;
        }
        await handler(req, res, next);
      })().catch(next);
    };
  }

  router.get(
    '/setup',
    setupOnly(async (_req, res) => {
      sendPage(res, 200);
    }),
  );

  router.post(
    '/setup',
    formBody,
    setupOnly(async (req, res, next) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Browsers submit the form as urlencoded; scripts send JSON. There is no
      // JavaScript on the page, so the redirect is the whole success path.
      const isForm = String(req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded');

      const fail = (status: number, message: string, code: string): void => {
        if (isForm) {
          sendPage(res, status, { error: message, email: typeof body.email === 'string' ? body.email : '' });
          return;
        }
        res.status(status).json({ error: message, code });
      };

      const email = normalizeEmail(body.email);
      if (!email) {
        fail(400, 'Enter a valid email address.', 'VALIDATION');
        return;
      }

      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length < MIN_PASSWORD_LENGTH) {
        fail(400, `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`, 'VALIDATION');
        return;
      }
      if (password.length > MAX_PASSWORD_LENGTH) {
        fail(400, `Use a password of at most ${MAX_PASSWORD_LENGTH} characters.`, 'VALIDATION');
        return;
      }
      if (typeof body.confirm === 'string' && body.confirm !== password) {
        fail(400, 'The passwords do not match.', 'VALIDATION');
        return;
      }

      let outcome: SetupOutcome;
      try {
        outcome = await createRootAdmin(db, email, password);
      } catch (err) {
        next(err);
        return;
      }

      // Another request created the root admin between the gate and the insert.
      if (outcome.kind === 'admin-exists') {
        next();
        return;
      }
      if (outcome.kind === 'email-taken') {
        fail(409, 'An account with that email already exists. Use a different address.', 'EMAIL_TAKEN');
        return;
      }

      if (isForm) {
        res.redirect(303, '/admin');
        return;
      }
      res.status(201).json({ ok: true, user: { ...outcome.user, role: 'admin' } });
    }),
  );

  return router;
}

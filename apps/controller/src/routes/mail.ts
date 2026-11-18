/**
 * Admin-configured SMTP settings and outbound mail.
 *
 * The operator supplies an existing mail server's credentials here. Secrets are
 * encrypted at rest and write-only over the API: an admin can replace the
 * password but never read it back, so a dashboard compromise does not hand over
 * working mail credentials.
 */
import { Router, type Request, type Response } from 'express';
import { issuePasswordReset, RESET_TTL_MINUTES } from '../services/account.js';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import { eq } from 'drizzle-orm';
import { asyncHandler, requireJwt } from '../middleware.js';
import { subscriptions, users } from '../db/schema.js';
import {
  describeSettings,
  setSetting,
  deleteSetting,
  SettingWrite,
} from '../services/settings.js';
import {
  SETTING_HOST,
  SETTING_PORT,
  SETTING_SECURE,
  SETTING_USER,
  SETTING_PASSWORD,
  SETTING_FROM,
  SETTING_FROM_NAME,
  loadSmtpSettings,
  isMailConfigured,
  validateSmtpSettings,
  sendMail,
  verifyMailSettings,
  invalidateMailTransport,
  passwordResetEmail,
  subscriptionLapsedEmail,
} from '../services/mail.js';

interface Ctx {
  db: Db;
  cfg: ControllerConfig;
}

/** Which stored key each body field maps to, and whether it is a secret. */
const FIELDS: Record<string, { key: string; secret: boolean }> = {
  host: { key: SETTING_HOST, secret: false },
  port: { key: SETTING_PORT, secret: false },
  secure: { key: SETTING_SECURE, secret: false },
  username: { key: SETTING_USER, secret: false },
  password: { key: SETTING_PASSWORD, secret: true },
  fromAddress: { key: SETTING_FROM, secret: false },
  fromName: { key: SETTING_FROM_NAME, secret: false },
};

export function buildMailRouter(ctx: Ctx): Router {
  const router = Router();

  const adminOnly = [
    requireJwt(ctx.cfg, ctx.db),
    (req: Request, res: Response, next: () => void) => {
      if (req.auth?.role !== 'admin') {
        res.status(403).json({ error: 'administrator access required', code: 'FORBIDDEN' });
        return;
      }
      next();
    },
  ];

  /** Current settings. The password is never included. */
  router.get(
    '/api/v1/admin/settings/email',
    ...adminOnly,
    asyncHandler(async (_req: Request, res: Response) => {
      const settings = await describeSettings(ctx.db, 'smtp.');
      const loaded = await loadSmtpSettings(ctx.db, ctx.cfg).catch(() => null);
      res.json({
        settings,
        configured: isMailConfigured(loaded),
        // Enough to render the form without ever sending the password.
        summary: loaded
          ? {
              host: loaded.host,
              port: loaded.port,
              secure: loaded.secure,
              username: loaded.username,
              fromAddress: loaded.fromAddress,
              fromName: loaded.fromName,
              passwordSet: loaded.password.length > 0,
            }
          : null,
      });
    }),
  );

  /**
   * Saves settings.
   *
   * An omitted field is left alone; `password: ''` clears the stored password.
   * That distinction is why the merge is per-field rather than a whole-object
   * write — "leave blank to keep the current one" is the common case.
   */
  router.put(
    '/api/v1/admin/settings/email',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown>;
      const provided = Object.keys(body).filter((k) => k in FIELDS);
      if (provided.length === 0) {
        res.status(400).json({ error: 'no recognised settings fields supplied', code: 'VALIDATION' });
        return;
      }

      // Validate before writing anything, so a bad port cannot leave the
      // settings half-updated.
      const candidate: Record<string, unknown> = {};
      const current = await loadSmtpSettings(ctx.db, ctx.cfg).catch(() => null);
      candidate.host = body.host ?? current?.host ?? '';
      candidate.port = body.port ?? current?.port ?? 587;
      candidate.fromAddress = body.fromAddress ?? current?.fromAddress ?? '';
      const errors = validateSmtpSettings(candidate);
      if (errors.length > 0) {
        res.status(400).json({ error: errors.join('; '), code: 'VALIDATION', details: errors });
        return;
      }

      const writes: SettingWrite[] = [];
      for (const field of provided) {
        const spec = FIELDS[field];
        if (!spec) continue;
        let value = String(body[field] ?? '');
        if (field === 'secure') value = value === 'true' ? 'true' : 'false';
        if (field === 'port') value = String(Number.parseInt(value, 10));
        writes.push({ key: spec.key, value, secret: spec.secret });
      }
      for (const w of writes) await setSetting(ctx.db, ctx.cfg, w, req.auth!.sub);

      // A changed host/credential must not keep using the old pooled connection.
      invalidateMailTransport();

      res.json({ ok: true, updated: provided.sort(), clearedSecretPassword: body.password === '' });
    }),
  );

  /** Removes all SMTP settings, disabling outbound mail. */
  router.delete(
    '/api/v1/admin/settings/email',
    ...adminOnly,
    asyncHandler(async (_req: Request, res: Response) => {
      for (const { key } of Object.values(FIELDS)) await deleteSetting(ctx.db, key);
      invalidateMailTransport();
      res.json({ ok: true });
    }),
  );

  /**
   * Sends a test message.
   *
   * The recipient is explicit rather than defaulted to the from address: an
   * operator configuring this wants to confirm it reaches *their* inbox, and
   * defaulting would send it back to the server itself and prove nothing.
   */
  router.post(
    '/api/v1/admin/settings/email/test',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { to?: string };
      const to = typeof body.to === 'string' ? body.to.trim() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        res.status(400).json({ error: 'a valid to address is required', code: 'VALIDATION' });
        return;
      }

      // Prove the connection and credentials before composing a message, so a
      // transport failure is reported as one and not as an unexplained send
      // failure. Nodemailer's verify carries the server's own reply.
      const verified = await verifyMailSettings(ctx.db, ctx.cfg);
      if (!verified.ok) {
        res.status(verified.reason === 'not_configured' ? 503 : 502).json({
          error: verified.reason === 'not_configured'
            ? 'mail is not configured'
            : 'could not connect to the mail server',
          code: verified.reason === 'not_configured' ? 'MAIL_NOT_CONFIGURED' : 'MAIL_CONNECTION_FAILED',
          detail: verified.detail,
        });
        return;
      }

      const result = await sendMail(ctx.db, ctx.cfg, {
        to,
        subject: 'StrictProxy mail configuration test',
        text: 'This is a test message confirming your StrictProxy mail settings work.',
      });
      if (result.sent) {
        res.json({ ok: true, verified: true, messageId: result.messageId });
        return;
      }
      // 503 for "not configured", 502 for "configured but the send failed" —
      // the operator needs to tell those apart.
      res.status(result.reason === 'not_configured' ? 503 : 502).json({
        error: result.reason === 'not_configured' ? 'mail is not configured' : 'test message could not be sent',
        code: result.reason === 'not_configured' ? 'MAIL_NOT_CONFIGURED' : 'MAIL_SEND_FAILED',
        detail: result.detail,
      });
    }),
  );

  /**
   * Sends a password reset email to a user.
   *
   * The recovery route an operator uses when mail is configured: it issues the
   * token and delivers it, instead of the token being handed over by hand.
   */
  router.post(
    '/api/v1/admin/users/:userId/password-reset/email',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const userId = typeof req.params.userId === 'string' ? req.params.userId : '';
      const [user] = await ctx.db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
      if (!user) {
        res.status(404).json({ error: 'user not found', code: 'NOT_FOUND' });
        return;
      }

      const issued = await issuePasswordReset(ctx.db, userId, { issuedBy: req.auth!.sub });
      const template = passwordResetEmail(ctx.cfg, issued.token, RESET_TTL_MINUTES);
      const result = await sendMail(ctx.db, ctx.cfg, { to: user.email, ...template });

      if (result.sent) {
        res.status(201).json({ email: user.email, delivered: true, expiresInMinutes: RESET_TTL_MINUTES });
        return;
      }
      if (result.reason === 'not_configured') {
        res.status(503).json({ error: 'mail is not configured', code: 'MAIL_NOT_CONFIGURED' });
        return;
      }
      res.status(502).json({ error: 'reset email could not be sent', code: 'MAIL_SEND_FAILED', detail: result.detail });
    }),
  );

  /**
   * Notifies users whose subscription has lapsed.
   *
   * Driven manually rather than from the sweep on purpose: an operator can see
   * who will be contacted first, and a mail outage cannot turn into a flood of
   * unwanted mail on recovery.
   */
  router.post(
    '/api/v1/admin/billing/lapse-notices',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { limit?: number };
      const limit = Math.min(Math.max(Number(body.limit ?? 50), 1), 500);

      const lapsed = await ctx.db
        .select({
          userId: subscriptions.userId,
          email: users.email,
          tier: subscriptions.tier,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
        })
        .from(subscriptions)
        .innerJoin(users, eq(users.id, subscriptions.userId))
        .where(eq(subscriptions.status, 'expired'))
        .limit(limit);

      const results = await Promise.all(
        lapsed.map(async (row) => {
          const template = subscriptionLapsedEmail({
            tier: row.tier,
            endedAt: row.currentPeriodEnd?.toISOString() ?? 'an earlier date',
            renewUrl: `${ctx.cfg.publicAppUrl.replace(/\/+$/, '')}/account/plan`,
          });
          const sent = await sendMail(ctx.db, ctx.cfg, { to: row.email, ...template });
          return { userId: row.userId, email: row.email, sent: sent.sent, reason: sent.sent ? undefined : sent.reason };
        }),
      );

      res.json({
        attempted: results.length,
        delivered: results.filter((r) => r.sent).length,
        failed: results.filter((r) => !r.sent).length,
        results,
      });
    }),
  );

  return router;
}

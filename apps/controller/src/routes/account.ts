/**
 * Account recovery, self-service deletion, and operator billing actions.
 *
 * These are the flows that decide whether a user can get back in after losing
 * their password, leave when they want to, and whether an operator can actually
 * issue the refund the payment docs describe.
 */
import bcrypt from 'bcryptjs';
import { Router, type Request, type Response } from 'express';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { asyncHandler, requireJwt } from '../middleware.js';
import { rateLimit } from '../services/rate-limit.js';
import { users, subscriptions } from '../db/schema.js';
import {
  issuePasswordReset,
  consumePasswordReset,
  clearPasswordResets,
  deleteAccount,
  RESET_TTL_MINUTES,
} from '../services/account.js';
import { revokeAllUserCredentials } from '../services/nodes.js';
import { revokeAllRefreshTokens, revokeAllRefreshTokens as revokeRefreshes } from '../services/auth.js';
import { createOpenPayClient, describeOpenPayError, isOpenPayConfigured } from '../services/openpay.js';
import { sendMail, passwordResetEmail } from '../services/mail.js';
import { billingCheckouts } from '../db/schema.js';
import { auditActor, recordAudit } from '../services/audit.js';

interface Ctx {
  db: Db;
  cfg: ControllerConfig;
  redis: Redis;
}

/** Mirrors the register endpoint's floor. */
const MIN_PASSWORD_LENGTH = 10;

export function buildAccountRouter(ctx: Ctx): Router {
  const router = Router();
  const limit = (bucket: string) =>
    rateLimit(ctx.cfg, { bucket, maxAttempts: ctx.cfg.rateLimitMaxAttempts, windowSeconds: ctx.cfg.rateLimitWindowSeconds });

  // -- password reset ------------------------------------------------------

  /**
   * Starts a password reset.
   *
   * Always answers 202 with the same body whether or not the address exists:
   * a differing response is an account-existence oracle. The token itself is
   * not returned here — that would make this endpoint a password reset for
   * anyone who knows an email. Operators issue a token instead (see the admin
   * route below) and hand it over out of band.
   */
  router.post(
    '/api/v1/auth/password/forgot',
    limit('auth.forgot'),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { email?: string };
      const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
      if (!email) {
        res.status(400).json({ error: 'email is required', code: 'VALIDATION' });
        return;
      }

      const [user] = await ctx.db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email)).limit(1);
      if (user) {
        const issued = await issuePasswordReset(ctx.db, user.id);
        const template = passwordResetEmail(ctx.cfg, issued.token, RESET_TTL_MINUTES);
        const result = await sendMail(ctx.db, ctx.cfg, { to: user.email, ...template });

        if (!result.sent && result.reason === 'not_configured') {
          // No mail transport: the token exists but cannot be delivered, so an
          // operator has to relay it. Never returned here — that would make this
          // endpoint a reset for anyone who knows an address.
          console.warn(
            '[controller] password reset requested but mail is not configured — issue a token via POST /api/v1/admin/users/:userId/password-reset',
          );
        } else if (!result.sent) {
          // The token is already issued and now undeliverable. Say so loudly: it
          // is the difference between "check your email" and "wait forever".
          console.error(`[controller] password reset email to ${user.email} failed: ${result.detail ?? result.reason}`);
        }
      }

      res.status(202).json({ accepted: true, message: 'If that account exists, a reset link has been sent.' });
    }),
  );

  /**
   * Completes a password reset with a token from the reset email or an operator.
   */
  router.post(
    '/api/v1/auth/password/reset',
    limit('auth.reset'),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { token?: string; password?: string };
      if (!body.token || !body.password) {
        res.status(400).json({ error: 'token and password are required', code: 'VALIDATION' });
        return;
      }
      if (body.password.length < MIN_PASSWORD_LENGTH) {
        res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters`, code: 'VALIDATION' });
        return;
      }

      const userId = await consumePasswordReset(ctx.db, {
        token: body.token,
        passwordHash: await bcrypt.hash(body.password, 12),
      });
      if (!userId) {
        // Unknown, used or expired are indistinguishable on purpose.
        res.status(400).json({ error: 'reset token is invalid or has expired', code: 'RESET_TOKEN_INVALID' });
        return;
      }

      res.json({ ok: true, message: 'Password updated. All sessions were signed out.' });
    }),
  );

  /** Password change for a signed-in user. */
  router.post(
    '/api/v1/auth/password/change',
    requireJwt(ctx.cfg, ctx.db),
    limit('auth.change'),
    asyncHandler(async (req: Request, res: Response) => {
      const claims = req.auth!;
      const body = req.body as { currentPassword?: string; newPassword?: string };
      if (!body.currentPassword || !body.newPassword) {
        res.status(400).json({ error: 'currentPassword and newPassword are required', code: 'VALIDATION' });
        return;
      }
      if (body.newPassword.length < MIN_PASSWORD_LENGTH) {
        res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters`, code: 'VALIDATION' });
        return;
      }

      const [user] = await ctx.db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, claims.sub))
        .limit(1);
      if (!user || !(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
        res.status(401).json({ error: 'current password is incorrect', code: 'INVALID_CREDENTIALS' });
        return;
      }

      await ctx.db
        .update(users)
        .set({ passwordHash: await bcrypt.hash(body.newPassword, 12), updatedAt: new Date() })
        .where(eq(users.id, claims.sub));

      // A password change signs out every session, including this one.
      await clearPasswordResets(ctx.db, claims.sub);
      await revokeRefreshes(ctx.db, claims.sub);
      res.json({ ok: true, message: 'Password changed. All sessions were signed out.' });
    }),
  );

  // -- self-service deletion ----------------------------------------------

  /**
   * Deletes the caller's account. Requires the current password so a stolen
   * access token alone cannot destroy someone's account.
   */
  router.delete(
    '/api/v1/me',
    requireJwt(ctx.cfg, ctx.db),
    asyncHandler(async (req: Request, res: Response) => {
      const claims = req.auth!;
      const body = req.body as { password?: string };

      const [user] = await ctx.db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, claims.sub))
        .limit(1);
      if (!user) {
        res.status(404).json({ error: 'user not found', code: 'NOT_FOUND' });
        return;
      }
      // bcrypt.compare, not a hash/plaintext comparison: what is stored is a
      // hash and what is presented is plaintext, so they are not comparable.
      if (!body.password || !(await bcrypt.compare(body.password, user.passwordHash))) {
        res.status(401).json({ error: 'password is incorrect', code: 'INVALID_CREDENTIALS' });
        return;
      }

      await clearPasswordResets(ctx.db, claims.sub);
      const deleted = await deleteAccount(ctx.db, claims.sub);
      if (!deleted) {
        res.status(500).json({ error: 'account deletion failed', code: 'INTERNAL' });
        return;
      }
      res.json({ ok: true, message: 'Account deleted.' });
    }),
  );

  // -- admin: operator-mediated recovery ----------------------------------

  /**
   * Issues a reset token for another user.
   *
   * The recovery path while there is no mail transport: an operator verifies the
   * user however they choose, then relays the token. The token is returned once,
   * to the admin only.
   */
  router.post(
    '/api/v1/admin/users/:userId/password-reset',
    ...adminOnly(ctx),
    asyncHandler(async (req: Request, res: Response) => {
      const userId = typeof req.params.userId === 'string' ? req.params.userId : '';
      if (!userId) {
        res.status(400).json({ error: 'userId is required', code: 'VALIDATION' });
        return;
      }
      const [user] = await ctx.db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
      if (!user) {
        res.status(404).json({ error: 'user not found', code: 'NOT_FOUND' });
        return;
      }

      const issued = await issuePasswordReset(ctx.db, userId, { issuedBy: req.auth!.sub });
      await recordAudit(ctx.db, {
        ...auditActor(req),
        action: 'user.password_reset_issued',
        targetType: 'user',
        targetId: userId,
        summary: `Password reset token issued for ${user.email}`,
        // The token itself is never logged: the audit trail must not become a
        // second copy of a one-time credential.
        metadata: { expiresAt: issued.expiresAt.toISOString() },
      });
      res.status(201).json({
        email: user.email,
        token: issued.token,
        expiresAt: issued.expiresAt.toISOString(),
        expiresInMinutes: RESET_TTL_MINUTES,
        notice: 'Relayed out of band; the token is not emailed because no mail transport is configured.',
      });
    }),
  );

  // -- admin: refunds and cancellations ------------------------------------

  /**
   * Refunds a settled checkout.
   *
   * The payment docs call refunds an operator decision; this is how an operator
   * makes one. A full refund also revokes access, because the money is going
   * back — a partial refund deliberately does not, since part of the period was
   * paid for.
   */
  router.post(
    '/api/v1/admin/billing/refund',
    ...adminOnly(ctx),
    asyncHandler(async (req: Request, res: Response) => {
      if (!isOpenPayConfigured(ctx.cfg)) {
        res.status(503).json({ error: 'billing gateway is not configured', code: 'BILLING_NOT_CONFIGURED' });
        return;
      }

      const body = req.body as { reference?: string; amountMinor?: number; reason?: string };
      const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
      if (!reference) {
        res.status(400).json({ error: 'reference is required', code: 'VALIDATION' });
        return;
      }

      // Resolve the checkout to a provider reference and its owner.
      const [row] = await ctx.db
        .select({
          userId: billingCheckouts.userId,
          providerReference: billingCheckouts.providerReference,
          amountMinor: billingCheckouts.amountMinor,
          status: billingCheckouts.status,
        })
        .from(billingCheckouts)
        .where(eq(billingCheckouts.reference, reference))
        .limit(1);
      if (!row || !row.providerReference) {
        res.status(404).json({ error: 'no settled checkout for that reference', code: 'NOT_FOUND' });
        return;
      }
      if (row.status !== 'paid') {
        res.status(409).json({ error: `checkout is ${row.status}, not settled`, code: 'CHECKOUT_NOT_SETTLED' });
        return;
      }

      const amountMinor = typeof body.amountMinor === 'number' ? Math.trunc(body.amountMinor) : undefined;
      if (amountMinor !== undefined && (amountMinor <= 0 || amountMinor > row.amountMinor)) {
        res.status(400).json({ error: 'amountMinor must be positive and no more than the amount charged', code: 'VALIDATION' });
        return;
      }

      try {
        const client = createOpenPayClient(ctx.cfg);
        const refund = await client.charges.refund(
          row.providerReference,
          amountMinor !== undefined ? { amount: amountMinor, reason: body.reason } : { reason: body.reason },
        );

        const full = amountMinor === undefined || amountMinor >= row.amountMinor;
        if (full) {
          // Money is going back in full; stop serving.
          await revokeAllUserCredentials(ctx.db, row.userId);
          await revokeAllRefreshTokens(ctx.db, row.userId);
          await ctx.db
            .update(subscriptions)
            .set({ tier: 'free', status: 'revoked', currentPeriodEnd: null, updatedAt: new Date() })
            .where(eq(subscriptions.userId, row.userId));
        }

        await recordAudit(ctx.db, {
          ...auditActor(req),
          action: 'billing.refund',
          targetType: 'checkout',
          targetId: reference,
          summary: `${full ? 'Full' : 'Partial'} refund of ${amountMinor ?? row.amountMinor} on ${reference}${full ? '; access revoked' : ''}`,
          metadata: {
            amountMinor: amountMinor ?? row.amountMinor,
            full,
            accessRevoked: full,
            reason: body.reason ?? null,
          },
        });
        res.json({ refund, full, accessRevoked: full });
      } catch (err) {
        const described = describeOpenPayError(err);
        res.status(described.status).json({ error: described.message, code: described.code, providerCode: described.providerCode });
      }
    }),
  );

  return router;
}

/** JWT + admin role, applied after the caller's own token check. */
function adminOnly(ctx: Ctx) {
  return [
    requireJwt(ctx.cfg, ctx.db),
    (req: Request, res: Response, next: () => void) => {
      if (req.auth?.role !== 'admin') {
        res.status(403).json({ error: 'administrator access required', code: 'FORBIDDEN' });
        return;
      }
      next();
    },
  ];
}

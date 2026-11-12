/**
 * Coupon administration.
 *
 * Codes are created and retired here; redemption itself lives in checkout. A
 * code can be a percentage or a fixed amount in the billing currency, optionally
 * capped by uses and expiry. Deactivating is preferred to deleting so the
 * redemptions already made keep a record of what they were for.
 */
import { Router, type Request, type Response } from 'express';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import { asyncHandler, requireJwt } from '../middleware.js';
import { coupons } from '../db/schema.js';
import { normalizeCouponCode } from '../services/coupons.js';
import { validateCurrency } from '../services/pricing.js';
import { auditActor, recordAudit } from '../services/audit.js';

interface Ctx {
  db: Db;
  cfg: ControllerConfig;
}

function couponJson(row: typeof coupons.$inferSelect) {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    percentOff: row.percentOff,
    amountOffMinor: row.amountOffMinor,
    currency: row.currency,
    maxRedemptions: row.maxRedemptions,
    timesRedeemed: row.timesRedeemed,
    active: row.active,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

export function buildCouponsAdminRouter(ctx: Ctx): Router {
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

  router.get(
    '/api/v1/admin/coupons',
    ...adminOnly,
    asyncHandler(async (_req: Request, res: Response) => {
      const rows = await ctx.db.select().from(coupons).orderBy(desc(coupons.createdAt));
      res.json({ coupons: rows.map(couponJson) });
    }),
  );

  router.post(
    '/api/v1/admin/coupons',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as {
        code?: unknown;
        kind?: unknown;
        percentOff?: unknown;
        amountOffMinor?: unknown;
        currency?: unknown;
        maxRedemptions?: unknown;
        expiresAt?: unknown;
        note?: unknown;
      };

      const code = normalizeCouponCode(body.code);
      if (!code) {
        res.status(400).json({ error: 'code must be 3-40 letters, digits, - or _', code: 'VALIDATION' });
        return;
      }

      const kind = body.kind === 'amount' ? 'amount' : body.kind === 'percent' ? 'percent' : null;
      if (!kind) {
        res.status(400).json({ error: 'kind must be "percent" or "amount"', code: 'VALIDATION' });
        return;
      }

      let percentOff: number | null = null;
      let amountOffMinor: number | null = null;
      let currency: string | null = null;
      if (kind === 'percent') {
        percentOff = Number(body.percentOff);
        if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) {
          res.status(400).json({ error: 'percentOff must be an integer from 1 to 100', code: 'VALIDATION' });
          return;
        }
      } else {
        amountOffMinor = Number(body.amountOffMinor);
        if (!Number.isInteger(amountOffMinor) || amountOffMinor <= 0) {
          res.status(400).json({ error: 'amountOffMinor must be a positive integer (minor units)', code: 'VALIDATION' });
          return;
        }
        try {
          currency = validateCurrency(body.currency);
        } catch (err) {
          res.status(400).json({ error: (err as Error).message, code: 'VALIDATION' });
          return;
        }
      }

      let maxRedemptions: number | null = null;
      if (body.maxRedemptions !== undefined && body.maxRedemptions !== null && body.maxRedemptions !== '') {
        maxRedemptions = Number(body.maxRedemptions);
        if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1 || maxRedemptions > 1_000_000) {
          res.status(400).json({ error: 'maxRedemptions must be a positive integer', code: 'VALIDATION' });
          return;
        }
      }

      let expiresAt: Date | null = null;
      if (typeof body.expiresAt === 'string' && body.expiresAt.trim()) {
        expiresAt = new Date(body.expiresAt);
        if (Number.isNaN(expiresAt.getTime())) {
          res.status(400).json({ error: 'expiresAt must be a date', code: 'VALIDATION' });
          return;
        }
        if (expiresAt.getTime() <= Date.now()) {
          res.status(400).json({ error: 'expiresAt must be in the future', code: 'VALIDATION' });
          return;
        }
      }

      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : null;

      let row: typeof coupons.$inferSelect | undefined;
      try {
        [row] = await ctx.db
          .insert(coupons)
          .values({
            code,
            kind,
            percentOff,
            amountOffMinor,
            currency,
            maxRedemptions,
            expiresAt,
            note: note || null,
            createdBy: req.auth?.sub ?? null,
          })
          .returning();
      } catch (err) {
        // One code means one offer; a duplicate is a conflict, not a server fault.
        if ((err as { code?: string }).code === '23505') {
          res.status(409).json({ error: 'a coupon with that code already exists', code: 'COUPON_EXISTS' });
          return;
        }
        throw err;
      }

      if (!row) {
        res.status(500).json({ error: 'coupon could not be created', code: 'INTERNAL' });
        return;
      }
      await recordAudit(ctx.db, {
        ...auditActor(req),
        action: 'coupon.created',
        targetType: 'coupon',
        targetId: row.id,
        summary: `Coupon ${code} created (${kind === 'percent' ? `${percentOff}% off` : `${amountOffMinor} ${currency} off`})`,
        metadata: { code, kind, percentOff, amountOffMinor, currency, maxRedemptions, expiresAt: expiresAt?.toISOString() ?? null },
      });

      res.status(201).json({ coupon: couponJson(row) });
    }),
  );

  router.patch(
    '/api/v1/admin/coupons/:id',
    ...adminOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? '');
      const body = req.body as { active?: unknown };
      if (typeof body.active !== 'boolean') {
        res.status(400).json({ error: 'active must be a boolean', code: 'VALIDATION' });
        return;
      }
      const [row] = await ctx.db.update(coupons).set({ active: body.active }).where(eq(coupons.id, id)).returning();
      if (!row) {
        res.status(404).json({ error: 'coupon not found', code: 'NOT_FOUND' });
        return;
      }
      await recordAudit(ctx.db, {
        ...auditActor(req),
        action: body.active ? 'coupon.enabled' : 'coupon.disabled',
        targetType: 'coupon',
        targetId: row.id,
        summary: `Coupon ${row.code} ${body.active ? 'enabled' : 'disabled'}`,
        metadata: { code: row.code, active: body.active },
      });
      res.json({ coupon: couponJson(row) });
    }),
  );

  return router;
}

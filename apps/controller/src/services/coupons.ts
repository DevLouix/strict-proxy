/**
 * Local discount codes.
 *
 * A coupon is enforced here, not at the gateway: the amount charged is decided
 * from data we control, the redemption is recorded against the account, and a
 * code can be revoked without touching the provider. Checkout still only
 * records intent — entitlement remains driven by the verified payment webhook,
 * so a discounted checkout is not a free pass.
 */
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { couponRedemptions, coupons } from '../db/schema.js';

export type CouponKind = 'percent' | 'amount';

export type CouponErrorCode =
  | 'COUPON_INVALID'
  | 'COUPON_EXPIRED'
  | 'COUPON_EXHAUSTED'
  | 'COUPON_ALREADY_USED';

export class CouponError extends Error {
  constructor(
    readonly code: CouponErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CouponError';
  }
}

export interface CouponRow {
  id: string;
  code: string;
  kind: string;
  percentOff: number | null;
  amountOffMinor: number | null;
  currency: string | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  active: boolean;
  expiresAt: Date | null;
  note: string | null;
}

export interface CouponPreview {
  code: string;
  kind: CouponKind;
  percentOff: number | null;
  amountOffMinor: number | null;
  currency: string | null;
  expiresAt: string | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
}

export interface AppliedCoupon {
  couponId: string;
  code: string;
  discountMinor: number;
  amountMinor: number;
  currency: string;
}

/** Codes are case-insensitive, trimmed, and limited to URL-safe characters. */
export function normalizeCouponCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(code) ? code : null;
}

export function couponPreview(row: CouponRow): CouponPreview {
  return {
    code: row.code,
    kind: row.kind === 'amount' ? 'amount' : 'percent',
    percentOff: row.percentOff,
    amountOffMinor: row.amountOffMinor,
    currency: row.currency,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    maxRedemptions: row.maxRedemptions,
    timesRedeemed: row.timesRedeemed,
  };
}

/**
 * Discount for one price.
 *
 * Capped so at least one minor unit remains payable: a "100% off" code would
 * otherwise open a zero-amount checkout, and an unpaid checkout must never mint
 * entitlement.
 */
export function discountMinorFor(row: CouponRow, amountMinor: number, currency: string): number {
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    throw new CouponError('COUPON_INVALID', 'the checkout amount is not valid for a coupon');
  }
  let discount: number;
  if (row.kind === 'percent') {
    const percent = row.percentOff ?? 0;
    if (!Number.isInteger(percent) || percent <= 0 || percent > 100) {
      throw new CouponError('COUPON_INVALID', 'this coupon has no usable percentage');
    }
    discount = Math.floor((amountMinor * percent) / 100);
  } else if (row.kind === 'amount') {
    if (row.currency && row.currency.toUpperCase() !== currency.toUpperCase()) {
      throw new CouponError('COUPON_INVALID', `this coupon is only valid in ${row.currency}`);
    }
    discount = row.amountOffMinor ?? 0;
    if (!Number.isInteger(discount) || discount <= 0) {
      throw new CouponError('COUPON_INVALID', 'this coupon has no usable amount');
    }
  } else {
    throw new CouponError('COUPON_INVALID', 'this coupon has an unsupported discount type');
  }
  return Math.min(discount, Math.max(0, amountMinor - 1));
}

function assertUsable(row: CouponRow | undefined, now = new Date()): CouponRow {
  if (!row || !row.active) throw new CouponError('COUPON_INVALID', 'that code is not valid');
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    throw new CouponError('COUPON_EXPIRED', 'that code has expired');
  }
  if (row.maxRedemptions !== null && row.timesRedeemed >= row.maxRedemptions) {
    throw new CouponError('COUPON_EXHAUSTED', 'that code has been fully redeemed');
  }
  return row;
}

async function loadCoupon(db: Db, code: string): Promise<CouponRow | undefined> {
  const [row] = await db.select().from(coupons).where(eq(coupons.code, code)).limit(1);
  return row as CouponRow | undefined;
}

/** Validates a code without redeeming it, for showing a discounted price. */
export async function previewCoupon(db: Db, rawCode: string): Promise<CouponPreview> {
  const code = normalizeCouponCode(rawCode);
  if (!code) throw new CouponError('COUPON_INVALID', 'that code is not valid');
  return couponPreview(assertUsable(await loadCoupon(db, code)));
}

/**
 * Reserves one redemption before a payable session is opened.
 *
 * Reservation is deliberate: the checkout amount is discounted first, so the
 * limit has to be enforced before the provider sees it. If the provider call
 * then fails, `releaseCoupon` puts the use back. The unique (coupon, user) row
 * is what stops one account reusing a code.
 */
export async function reserveCoupon(
  db: Db,
  params: { code: string; userId: string; amountBeforeMinor: number; currency: string },
): Promise<AppliedCoupon> {
  const code = normalizeCouponCode(params.code);
  if (!code) throw new CouponError('COUPON_INVALID', 'that code is not valid');

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(coupons).where(eq(coupons.code, code)).limit(1);
    const coupon = assertUsable(row as CouponRow | undefined);
    const discountMinor = discountMinorFor(coupon, params.amountBeforeMinor, params.currency);
    const amountMinor = params.amountBeforeMinor - discountMinor;

    const [redemption] = await tx
      .insert(couponRedemptions)
      .values({
        couponId: coupon.id,
        userId: params.userId,
        amountBeforeMinor: params.amountBeforeMinor,
        amountAfterMinor: amountMinor,
        currency: params.currency,
      })
      .onConflictDoNothing()
      .returning({ id: couponRedemptions.id });
    if (!redemption) throw new CouponError('COUPON_ALREADY_USED', 'you have already used that code');

    const [updated] = await tx
      .update(coupons)
      .set({ timesRedeemed: sql`${coupons.timesRedeemed} + 1` })
      .where(
        and(
          eq(coupons.id, coupon.id),
          eq(coupons.active, true),
          or(isNull(coupons.maxRedemptions), lt(coupons.timesRedeemed, coupons.maxRedemptions)),
          or(isNull(coupons.expiresAt), gt(coupons.expiresAt, new Date())),
        ),
      )
      .returning({ id: coupons.id });
    // Throwing rolls the redemption insert back, so a lost race cannot consume
    // a use without also producing a checkout.
    if (!updated) throw new CouponError('COUPON_EXHAUSTED', 'that code has been fully redeemed');

    return { couponId: coupon.id, code, discountMinor, amountMinor, currency: params.currency };
  });
}

/** Gives a reservation back when the provider never produced a session. */
export async function releaseCoupon(db: Db, couponId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .delete(couponRedemptions)
      .where(and(eq(couponRedemptions.couponId, couponId), eq(couponRedemptions.userId, userId)))
      .returning({ id: couponRedemptions.id });
    if (rows.length === 0) return;
    await tx
      .update(coupons)
      .set({ timesRedeemed: sql`greatest(${coupons.timesRedeemed} - 1, 0)` })
      .where(eq(coupons.id, couponId));
  });
}

/** Stores the checkout reference on the redemption once one exists. */
export async function linkCouponRedemption(
  db: Db,
  params: { couponId: string; userId: string; checkoutReference: string },
): Promise<void> {
  await db
    .update(couponRedemptions)
    .set({ checkoutReference: params.checkoutReference })
    .where(and(eq(couponRedemptions.couponId, params.couponId), eq(couponRedemptions.userId, params.userId)));
}

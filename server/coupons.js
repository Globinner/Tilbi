const crypto = require('crypto');
const { dbHelpers } = require('./database');

const DURATION_TO_PLAN = {
  3: 'coupon_3m',
  6: 'coupon_6m',
  12: 'coupon_1y',
};

const PLAN_LABELS = {
  coupon_3m: 'Coupon — 3 months',
  coupon_6m: 'Coupon — 6 months',
  coupon_1y: 'Coupon — 1 year',
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function durationLabel(months) {
  if (months === 12) return '1 year';
  return `${months} months`;
}

function planTypeForDuration(months) {
  return DURATION_TO_PLAN[months] || null;
}

function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);
  return d;
}

function randomSegment(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

function codePrefix(months) {
  if (months === 12) return 'TILBI-1Y';
  if (months === 6) return 'TILBI-6M';
  return 'TILBI-3M';
}

function generateCouponCode(months) {
  return `${codePrefix(months)}-${randomSegment(6)}`;
}

function normalizeCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

async function generateCoupons(durationMonths, count = 1, options = {}) {
  const months = Number(durationMonths);
  const n = Math.min(50, Math.max(1, Number(count) || 1));
  if (![3, 6, 12].includes(months)) {
    throw new Error('Duration must be 3, 6, or 12 months');
  }

  const created = [];
  for (let i = 0; i < n; i++) {
    let code = generateCouponCode(months);
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const row = await dbHelpers.createCoupon({
          code,
          durationMonths: months,
          maxRedemptions: options.maxRedemptions || 1,
          expiresAt: options.expiresAt || null,
          notes: options.notes || null,
        });
        created.push({
          id: row.id,
          code,
          durationMonths: months,
          planType: planTypeForDuration(months),
          label: durationLabel(months),
        });
        break;
      } catch (err) {
        if (!/UNIQUE/i.test(err.message) || attempt === 7) throw err;
        code = generateCouponCode(months);
      }
    }
  }
  return created;
}

async function listCoupons() {
  const rows = await dbHelpers.listCoupons();
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    durationMonths: row.duration_months,
    planType: planTypeForDuration(row.duration_months),
    label: durationLabel(row.duration_months),
    maxRedemptions: row.max_redemptions,
    redemptionCount: row.redemption_count,
    remaining: Math.max(0, row.max_redemptions - row.redemption_count),
    expiresAt: row.expires_at,
    notes: row.notes,
    createdAt: row.created_at,
  }));
}

async function redeemCoupon(userId, rawCode) {
  const code = normalizeCode(rawCode);
  if (!/^[A-Z0-9-]{8,32}$/.test(code)) {
    throw new Error('Invalid coupon code');
  }

  const coupon = await dbHelpers.getCouponByCode(code);
  if (!coupon) {
    throw new Error('Coupon not found');
  }
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    throw new Error('This coupon has expired');
  }
  if (coupon.redemption_count >= coupon.max_redemptions) {
    throw new Error('This coupon has already been used');
  }

  const already = await dbHelpers.getCouponRedemption(coupon.id, userId);
  if (already) {
    throw new Error('You already redeemed this coupon');
  }

  const existing = await dbHelpers.getActiveSubscription(userId);
  if (existing && existing.payment_provider !== 'coupon' && existing.status === 'active') {
    throw new Error('You already have an active paid subscription');
  }

  const bumped = await dbHelpers.incrementCouponRedemption(coupon.id);
  if (!bumped.changes) {
    throw new Error('This coupon has already been used');
  }

  const planType = planTypeForDuration(coupon.duration_months);
  const now = new Date();
  let periodStart = now;
  let periodEnd;

  if (existing && existing.payment_provider === 'coupon' && existing.status === 'active') {
    const currentEnd = new Date(existing.current_period_end);
    const startFrom = currentEnd > now ? currentEnd : now;
    periodStart = new Date(existing.current_period_start || now);
    periodEnd = addMonths(startFrom, coupon.duration_months);
    await dbHelpers.updateSubscriptionById(existing.id, {
      status: 'active',
      planType,
      currentPeriodStart: periodStart.toISOString(),
      currentPeriodEnd: periodEnd.toISOString(),
      cancelAtPeriodEnd: true,
    });
    await dbHelpers.recordCouponRedemption({
      couponId: coupon.id,
      userId,
      subscriptionId: existing.id,
    });
    return {
      planType,
      durationMonths: coupon.duration_months,
      label: durationLabel(coupon.duration_months),
      currentPeriodStart: periodStart.toISOString(),
      currentPeriodEnd: periodEnd.toISOString(),
      stacked: true,
    };
  }

  periodEnd = addMonths(now, coupon.duration_months);
  const created = await dbHelpers.createSubscription(userId, {
    paymentProvider: 'coupon',
    planType,
    status: 'active',
    currentPeriodStart: periodStart.toISOString(),
    currentPeriodEnd: periodEnd.toISOString(),
    cancelAtPeriodEnd: true,
  });
  await dbHelpers.recordCouponRedemption({
    couponId: coupon.id,
    userId,
    subscriptionId: created.id,
  });

  return {
    planType,
    durationMonths: coupon.duration_months,
    label: durationLabel(coupon.duration_months),
    currentPeriodStart: periodStart.toISOString(),
    currentPeriodEnd: periodEnd.toISOString(),
    stacked: false,
  };
}

module.exports = {
  DURATION_TO_PLAN,
  PLAN_LABELS,
  durationLabel,
  planTypeForDuration,
  generateCouponCode,
  generateCoupons,
  listCoupons,
  redeemCoupon,
  normalizeCode,
};

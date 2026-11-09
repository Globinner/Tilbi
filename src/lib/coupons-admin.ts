import type { CouponRow } from '@/types/coupons';

const BILLING = 'http://127.0.0.1:3001';

async function billing(path: string, init?: RequestInit) {
  const res = await fetch(`${BILLING}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(init && init.headers),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data && data.error) || `Billing HTTP ${res.status}`);
  }
  return data;
}

export async function listOwnerCoupons(): Promise<CouponRow[]> {
  const data = await billing('/api/admin/coupons');
  return data.coupons || [];
}

export async function createOwnerCoupons(durationMonths: number, count: number): Promise<CouponRow[]> {
  const data = await billing('/api/admin/coupons', {
    method: 'POST',
    body: JSON.stringify({ durationMonths, count, maxRedemptions: 1 }),
  });
  return data.coupons || [];
}

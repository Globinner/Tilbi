import type { Metadata } from 'next';
import { CouponAdmin } from '@/components/dashboard/CouponAdmin';

export const metadata: Metadata = {
  title: 'Globinner · Tilbi coupons',
  robots: { index: false, follow: false },
};

export default function AdminCouponsPage() {
  return (
    <main className="min-h-screen bg-slate-950">
      <CouponAdmin />
    </main>
  );
}

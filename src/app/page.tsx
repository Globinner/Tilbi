import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950">
      <Link
        href="/admin/coupons"
        className="rounded-lg bg-sky-600 px-6 py-3 font-semibold text-white hover:bg-sky-500"
      >
        Tilbi coupon admin
      </Link>
    </main>
  );
}

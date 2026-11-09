import { NextRequest, NextResponse } from 'next/server';
import { createOwnerCoupons, listOwnerCoupons } from '@/lib/coupons-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isOwnerRequest(request: NextRequest) {
  if (process.env.VERCEL) return false;
  const host = request.headers.get('host') || '';
  return host.startsWith('127.0.0.1') || host.startsWith('localhost');
}

export async function GET(request: NextRequest) {
  if (!isOwnerRequest(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  try {
    const coupons = await listOwnerCoupons();
    return NextResponse.json({ coupons });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not list coupons';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isOwnerRequest(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  try {
    const body = await request.json().catch(() => ({}));
    const durationMonths = Number(body.durationMonths);
    const count = Number(body.count || 1);
    const coupons = await createOwnerCoupons(durationMonths, count);
    return NextResponse.json({ success: true, coupons });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create coupons';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

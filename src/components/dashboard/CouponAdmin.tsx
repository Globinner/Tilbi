'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CouponRow } from '@/types/coupons';

type Filter = 'unused' | 'all' | 'used';

export function CouponAdmin() {
  const [coupons, setCoupons] = useState<CouponRow[]>([]);
  const [filter, setFilter] = useState<Filter>('unused');
  const [months, setMonths] = useState('1');
  const [count, setCount] = useState('5');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError('');
    const res = await fetch('/api/admin/coupons', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setCoupons(data.coupons || []);
  }, []);

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load coupons'))
      .finally(() => setLoading(false));
  }, [load]);

  const unused = useMemo(() => coupons.filter((c) => c.remaining > 0), [coupons]);
  const used = useMemo(() => coupons.filter((c) => c.remaining <= 0), [coupons]);
  const visible = filter === 'unused' ? unused : filter === 'used' ? used : coupons;

  async function copyUnused() {
    await navigator.clipboard.writeText(unused.map((c) => c.code).join('\n'));
    setMessage(`Copied ${unused.length} unused code(s).`);
  }

  async function generate() {
    setError('');
    setMessage('');
    const res = await fetch('/api/admin/coupons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        durationMonths: Number(months),
        count: Number(count),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || 'Could not generate coupons');
      return;
    }
    setMessage(`Created ${(data.coupons || []).length} code(s).`);
    await load();
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 text-slate-100">
      <p className="mb-1 text-xs uppercase tracking-[0.2em] text-sky-300">Globinner</p>
      <h1 className="mb-1 text-3xl font-semibold">Tilbi coupons</h1>
      <p className="mb-6 text-sm text-slate-400">Owner only. Tilbi users never see this page.</p>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
          <b className="block text-2xl">{unused.length}</b>
          <span className="text-xs text-slate-400">Unused</span>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
          <b className="block text-2xl">{used.length}</b>
          <span className="text-xs text-slate-400">Used up</span>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
          <b className="block text-2xl">{coupons.length}</b>
          <span className="text-xs text-slate-400">Total codes</span>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
        >
          <option value="unused">Unused only</option>
          <option value="all">All</option>
          <option value="used">Used up</option>
        </select>
        <button type="button" onClick={() => load().catch((err) => setError(err.message))} className="rounded-md bg-slate-700 px-3 py-2 text-sm font-semibold">
          Refresh
        </button>
        <button type="button" onClick={copyUnused} className="rounded-md bg-sky-600 px-3 py-2 text-sm font-semibold">
          Copy unused codes
        </button>
        <select
          value={months}
          onChange={(e) => setMonths(e.target.value)}
          className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
        >
          <option value="1">1 month</option>
          <option value="3">3 months</option>
          <option value="6">6 months</option>
          <option value="12">1 year</option>
        </select>
        <input
          type="number"
          min={1}
          max={50}
          value={count}
          onChange={(e) => setCount(e.target.value)}
          className="w-20 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
        />
        <button type="button" onClick={generate} className="rounded-md bg-sky-600 px-3 py-2 text-sm font-semibold">
          Generate
        </button>
      </div>

      {loading ? <p className="text-sm text-slate-400">Loading coupons…</p> : null}
      {message ? <p className="mb-3 text-sm text-emerald-300">{message}</p> : null}
      {error ? <p className="mb-3 text-sm text-red-300">{error}</p> : null}

      <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-900">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="text-slate-400">
              <th className="px-3 py-2 font-semibold">Code</th>
              <th className="px-3 py-2 font-semibold">Duration</th>
              <th className="px-3 py-2 font-semibold">Used</th>
              <th className="px-3 py-2 font-semibold">Left</th>
              <th className="px-3 py-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => (
              <tr key={c.code} className="border-t border-slate-800">
                <td className="px-3 py-2 font-mono">{c.code}</td>
                <td className="px-3 py-2">{c.label}</td>
                <td className="px-3 py-2">
                  {c.redemptionCount}/{c.maxRedemptions}
                </td>
                <td className="px-3 py-2">{c.remaining}</td>
                <td className={`px-3 py-2 ${c.remaining > 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                  {c.remaining > 0 ? 'Available' : 'Used'}
                </td>
              </tr>
            ))}
            {!loading && visible.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-slate-400" colSpan={5}>
                  No coupons in this view.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

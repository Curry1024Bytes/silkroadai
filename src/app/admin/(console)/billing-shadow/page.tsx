'use client';

import { useSearchParams } from 'next/navigation';
import { useState, useEffect, useCallback, Suspense } from 'react';
import PayPageLayout from '@/components/PayPageLayout';
import { resolveLocale, type Locale } from '@/lib/locale';

// ── Types (mirror /api/admin/billing-shadow) ──

interface Summary {
    records: number;
    matched: number;
    unmatched: number;
    costCny: number;
    newapiQuota: number;
    newapiCny: number;
    diffCny: number;
    diffRate: number | null;
}
interface ModelRow {
    model_slug: string;
    tier: string;
    records: number;
    costCny: number;
    newapiQuota: number;
    newapiCny: number;
}
interface CustomerRow {
    user_id: string;
    email: string | null;
    records: number;
    costCny: number;
    newapiQuota: number;
    newapiCny: number;
}
interface UnmatchedRow {
    model_slug: string;
    tier: string;
    records: number;
}
interface ShadowData {
    period: string;
    rangeStart: string | null;
    summary: Summary;
    byModel: ModelRow[];
    byCustomer: CustomerRow[];
    unmatched: UnmatchedRow[];
}

type Period = '7d' | '30d' | 'all';
const PERIODS: Period[] = ['7d', '30d', 'all'];

function getTexts(locale: Locale) {
    return locale === 'en'
        ? {
              title: 'Shadow Metering',
              subtitle:
                  'P4a — what portal WOULD charge (¥/CatalogPrice) vs new-api actual quota. Not billed to customers.',
              shadowWarn: '⚠️ Shadow data — computed for reconciliation only, NOT applied to any customer balance.',
              invalidToken: 'Session expired, please sign in again',
              loadFailed: 'Failed to load shadow metering',
              refresh: 'Refresh',
              loading: 'Loading...',
              empty: 'No usage records yet — the meter polls new-api logs every 10 min.',
              p7d: 'Last 7d',
              p30d: 'Last 30d',
              pall: 'All',
              portalCost: 'Portal metered (¥)',
              newapiCost: 'new-api actual (¥)',
              diff: 'Difference',
              records: 'Records',
              matched: 'matched',
              unmatched: 'unmatched',
              byModel: 'By model × tier',
              byCustomer: 'By customer',
              unmatchedTitle: 'Unpriced (matched=false) — configure these on Pricing',
              colModel: 'Model',
              colTier: 'Tier',
              colCustomer: 'Customer',
              colRecords: 'Calls',
              colPortal: 'Portal ¥',
              colNewapi: 'new-api ¥',
              none: 'None 🎉',
          }
        : {
              title: '影子计量',
              subtitle: 'P4a — portal 按 CatalogPrice 算的 ¥ vs new-api 实扣 quota 对账。未对客户计费。',
              shadowWarn: '⚠️ 影子数据 —— 仅用于对账,未对任何客户余额生效。',
              invalidToken: '登录已过期',
              loadFailed: '加载影子计量失败',
              refresh: '刷新',
              loading: '加载中...',
              empty: '暂无计量记录 —— 计量 job 每 10 分钟轮询一次 new-api 日志。',
              p7d: '近 7 天',
              p30d: '近 30 天',
              pall: '全部',
              portalCost: 'portal 计量(¥)',
              newapiCost: 'new-api 实扣(¥)',
              diff: '差异',
              records: '记录数',
              matched: '已匹配',
              unmatched: '未匹配',
              byModel: '按模型 × 档次',
              byCustomer: '按客户',
              unmatchedTitle: '未配价(matched=false)—— 去「定价」页补上',
              colModel: '模型',
              colTier: '档次',
              colCustomer: '客户',
              colRecords: '调用',
              colPortal: 'portal ¥',
              colNewapi: 'new-api ¥',
              none: '无 🎉',
          };
}

const fmt = (n: number): string => `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}`;
const fmtPct = (r: number | null): string => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);

function ShadowContent() {
    const searchParams = useSearchParams();
    const theme = searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const uiMode = searchParams.get('ui_mode') || 'standalone';
    const locale = resolveLocale(searchParams.get('lang'));
    const isDark = theme === 'dark';
    const isEmbedded = uiMode === 'embedded';
    const t = getTexts(locale);

    const [data, setData] = useState<ShadowData | null>(null);
    const [period, setPeriod] = useState<Period>('7d');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const fetchData = useCallback(async (p: Period) => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch(`/api/admin/billing-shadow?period=${p}`);
            if (!res.ok) {
                if (res.status === 401) {
                    setError(t.invalidToken);
                    return;
                }
                throw new Error();
            }
            setData((await res.json()) as ShadowData);
        } catch {
            setError(t.loadFailed);
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetchData(period);
    }, [fetchData, period]);

    const card = isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm';
    const tableWrap = ['overflow-x-auto rounded-xl border', card].join(' ');
    const thCls = `px-4 py-3 font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`;
    const rowBorder = isDark ? 'border-slate-700/50' : 'border-slate-100';
    const btn = (active: boolean) =>
        [
            'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
            active
                ? 'border-emerald-500 bg-emerald-500 text-white'
                : isDark
                  ? 'border-slate-600 text-slate-300 hover:bg-slate-800'
                  : 'border-slate-300 text-slate-700 hover:bg-slate-100',
        ].join(' ');

    const periodLabel = (p: Period) => (p === '7d' ? t.p7d : p === '30d' ? t.p30d : t.pall);

    return (
        <PayPageLayout
            isDark={isDark}
            isEmbedded={isEmbedded}
            maxWidth="full"
            title={t.title}
            subtitle={t.subtitle}
            locale={locale}
            actions={
                <div className="flex flex-wrap gap-2">
                    {PERIODS.map((p) => (
                        <button key={p} type="button" onClick={() => setPeriod(p)} className={btn(period === p)}>
                            {periodLabel(p)}
                        </button>
                    ))}
                </div>
            }
        >
            {/* Shadow warning — make it impossible to mistake this for live billing. */}
            <div
                className={`mb-4 rounded-lg border p-3 text-sm font-medium ${isDark ? 'border-amber-700 bg-amber-950/40 text-amber-300' : 'border-amber-300 bg-amber-50 text-amber-800'}`}
            >
                {t.shadowWarn}
            </div>

            {error && (
                <div
                    className={`mb-4 rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/50 text-red-400' : 'border-red-200 bg-red-50 text-red-600'}`}
                >
                    {error}
                </div>
            )}

            {loading ? (
                <div className={`py-12 text-center ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>{t.loading}</div>
            ) : !data || data.summary.records === 0 ? (
                <div
                    className={`rounded-xl border p-12 text-center ${card} ${isDark ? 'text-slate-400' : 'text-gray-500'}`}
                >
                    {t.empty}
                </div>
            ) : (
                <div className="space-y-6">
                    {/* Summary cards */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <div className={`rounded-xl border p-4 ${card}`}>
                            <div className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                {t.portalCost}
                            </div>
                            <div
                                className={`mt-1 text-2xl font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}
                            >
                                {fmt(data.summary.costCny)}
                            </div>
                            <div className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                {data.summary.records} {t.records} · {data.summary.matched} {t.matched} ·{' '}
                                <span className={data.summary.unmatched > 0 ? 'text-amber-500' : ''}>
                                    {data.summary.unmatched} {t.unmatched}
                                </span>
                            </div>
                        </div>
                        <div className={`rounded-xl border p-4 ${card}`}>
                            <div className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                {t.newapiCost}
                            </div>
                            <div
                                className={`mt-1 text-2xl font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}
                            >
                                {fmt(data.summary.newapiCny)}
                            </div>
                            <div className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                quota {data.summary.newapiQuota.toLocaleString('zh-CN')}
                            </div>
                        </div>
                        <div className={`rounded-xl border p-4 ${card}`}>
                            <div className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{t.diff}</div>
                            <div
                                className={`mt-1 text-2xl font-semibold ${Math.abs(data.summary.diffCny) < 0.01 ? (isDark ? 'text-slate-100' : 'text-slate-900') : 'text-amber-500'}`}
                            >
                                {fmt(data.summary.diffCny)}
                            </div>
                            <div className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                {fmtPct(data.summary.diffRate)}
                            </div>
                        </div>
                    </div>

                    {/* Unmatched highlight */}
                    <div>
                        <div className={`mb-2 text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                            {t.unmatchedTitle}
                        </div>
                        {data.unmatched.length === 0 ? (
                            <div className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{t.none}</div>
                        ) : (
                            <div className="flex flex-wrap gap-2">
                                {data.unmatched.map((u) => (
                                    <span
                                        key={`${u.model_slug}-${u.tier}`}
                                        className={`rounded-lg border px-2 py-1 text-xs ${isDark ? 'border-amber-800 bg-amber-950/30 text-amber-300' : 'border-amber-200 bg-amber-50 text-amber-700'}`}
                                    >
                                        <span className="font-mono">{u.model_slug}</span> · {u.tier} · {u.records}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* By model × tier */}
                    <div>
                        <div className={`mb-2 text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                            {t.byModel}
                        </div>
                        <div className={tableWrap}>
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className={`border-b ${rowBorder}`}>
                                        <th className={`${thCls} text-left`}>{t.colModel}</th>
                                        <th className={`${thCls} text-left`}>{t.colTier}</th>
                                        <th className={`${thCls} text-right`}>{t.colRecords}</th>
                                        <th className={`${thCls} text-right`}>{t.colPortal}</th>
                                        <th className={`${thCls} text-right`}>{t.colNewapi}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.byModel.map((m) => (
                                        <tr key={`${m.model_slug}-${m.tier}`} className={`border-b ${rowBorder}`}>
                                            <td
                                                className={`px-4 py-3 font-mono text-xs ${isDark ? 'text-slate-200' : 'text-slate-800'}`}
                                            >
                                                {m.model_slug}
                                            </td>
                                            <td className={`px-4 py-3 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                                                {m.tier}
                                            </td>
                                            <td
                                                className={`px-4 py-3 text-right ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                                            >
                                                {m.records}
                                            </td>
                                            <td
                                                className={`px-4 py-3 text-right ${isDark ? 'text-slate-200' : 'text-slate-800'}`}
                                            >
                                                {fmt(m.costCny)}
                                            </td>
                                            <td
                                                className={`px-4 py-3 text-right ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                                            >
                                                {fmt(m.newapiCny)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* By customer */}
                    <div>
                        <div className={`mb-2 text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                            {t.byCustomer}
                        </div>
                        <div className={tableWrap}>
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className={`border-b ${rowBorder}`}>
                                        <th className={`${thCls} text-left`}>{t.colCustomer}</th>
                                        <th className={`${thCls} text-right`}>{t.colRecords}</th>
                                        <th className={`${thCls} text-right`}>{t.colPortal}</th>
                                        <th className={`${thCls} text-right`}>{t.colNewapi}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.byCustomer.map((c) => (
                                        <tr key={c.user_id} className={`border-b ${rowBorder}`}>
                                            <td className={`px-4 py-3 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                                                {c.email ?? c.user_id.slice(0, 8)}
                                            </td>
                                            <td
                                                className={`px-4 py-3 text-right ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                                            >
                                                {c.records}
                                            </td>
                                            <td
                                                className={`px-4 py-3 text-right ${isDark ? 'text-slate-200' : 'text-slate-800'}`}
                                            >
                                                {fmt(c.costCny)}
                                            </td>
                                            <td
                                                className={`px-4 py-3 text-right ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                                            >
                                                {fmt(c.newapiCny)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}
        </PayPageLayout>
    );
}

function ShadowFallback() {
    const searchParams = useSearchParams();
    const locale = resolveLocale(searchParams.get('lang'));
    return (
        <div className="flex min-h-screen items-center justify-center">
            <div className="text-slate-500">{locale === 'en' ? 'Loading...' : '加载中...'}</div>
        </div>
    );
}

export default function BillingShadowPage() {
    return (
        <Suspense fallback={<ShadowFallback />}>
            <ShadowContent />
        </Suspense>
    );
}

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
    coverage: number | null;
    costCny: number;
    newapiQuota: number;
    newapiCny: number;
    unmatchedNewapiCny: number;
    diffCny: number;
    diffRate: number | null;
}
interface ModelRow {
    model_slug: string;
    tier: string;
    records: number;
    matchedRecords: number;
    matchedRate: number | null;
    costCny: number;
    newapiQuota: number;
    newapiCny: number;
    diffCny: number;
    diffRate: number | null;
}
interface CustomerRow {
    user_id: string;
    email: string | null;
    records: number;
    costCny: number;
    newapiQuota: number;
    newapiCny: number;
    diffCny: number;
    diffRate: number | null;
}
interface TenantRow {
    tenant_id: string;
    slug: string | null;
    name: string | null;
    records: number;
    costCny: number;
    newapiQuota: number;
    newapiCny: number;
    diffCny: number;
    diffRate: number | null;
}
interface UnmatchedRow {
    model_slug: string;
    tier: string;
    records: number;
    newapiQuota: number;
    newapiCny: number;
}
export interface ShadowData {
    period: string;
    rangeStart: string | null;
    bigDiffThreshold: number;
    summary: Summary;
    byModel: ModelRow[];
    byCustomer: CustomerRow[];
    byTenant: TenantRow[];
    unmatched: UnmatchedRow[];
}

type Period = '7d' | '30d' | 'all';
const PERIODS: Period[] = ['7d', '30d', 'all'];

export function getTexts(locale: Locale) {
    return locale === 'en'
        ? {
              title: 'Reconciliation',
              subtitle:
                  'P4b — portal metered cost (¥/CatalogPrice) vs new-api actual quota. The verification gate before P4c (real billing).',
              shadowWarn: '⚠️ Shadow data — computed for reconciliation only, NOT applied to any customer balance.',
              howTo: 'How to read this',
              interpWhat:
                  'What portal WOULD charge if it took over billing, compared with what new-api actually deducts now. Not in effect — does not affect customers.',
              interpReady:
                  'Small difference + high coverage → the metering pipeline is trustworthy; the P4c switch can be considered.',
              interpNotReady:
                  'Large difference / low coverage → first price the unpriced models and align catalog to global, then keep observing.',
              invalidToken: 'Session expired, please sign in again',
              loadFailed: 'Failed to load reconciliation',
              loading: 'Loading...',
              empty: 'No usage records yet — the meter polls new-api logs every 10 min.',
              p7d: 'Last 7d',
              p30d: 'Last 30d',
              pall: 'All',
              portalCost: 'Portal metered (¥)',
              newapiCost: 'new-api actual (¥)',
              diff: 'Difference',
              coverage: 'Coverage',
              records: 'records',
              matched: 'matched',
              unmatched: 'unmatched',
              unmatchedShare: 'unpriced share of actual',
              byModel: 'By model × tier',
              byCustomer: 'By customer',
              byTenant: 'By tenant',
              unmatchedTitle: 'Unpriced (matched=false) — configure these on Pricing',
              colModel: 'Model',
              colTier: 'Tier',
              colCustomer: 'Customer',
              colTenant: 'Tenant',
              colRecords: 'Calls',
              colMatchedPct: 'Matched%',
              colPortal: 'Portal ¥',
              colNewapi: 'new-api ¥',
              colDiff: 'Diff ¥',
              colDiffPct: 'Diff%',
              none: 'None 🎉',
          }
        : {
              title: '对账报表',
              subtitle: 'P4b — portal 按 CatalogPrice 算的 ¥ vs new-api 实扣 quota。P4c 真扣费切换前的验证关。',
              shadowWarn: '⚠️ 影子数据 —— 仅用于对账,未对任何客户余额生效。',
              howTo: '怎么读这份报表',
              interpWhat: 'portal 假设接管计费会怎么算,对比 new-api 现在实际怎么扣。未生效、不影响客户。',
              interpReady: '差异小 + 覆盖率高 → 计量管道可信,可考虑 P4c 切换。',
              interpNotReady: '差异大 / 覆盖率低 → 先给未定价模型配价、把 catalog 对齐 global,再观察。',
              invalidToken: '登录已过期',
              loadFailed: '加载对账报表失败',
              loading: '加载中...',
              empty: '暂无计量记录 —— 计量 job 每 10 分钟轮询一次 new-api 日志。',
              p7d: '近 7 天',
              p30d: '近 30 天',
              pall: '全部',
              portalCost: 'portal 计量(¥)',
              newapiCost: 'new-api 实扣(¥)',
              diff: '差异',
              coverage: '覆盖率',
              records: '记录',
              matched: '已匹配',
              unmatched: '未匹配',
              unmatchedShare: '其中未配价占实扣',
              byModel: '按模型 × 档次',
              byCustomer: '按客户',
              byTenant: '按租户',
              unmatchedTitle: '未配价(matched=false)—— 去「定价」页补上',
              colModel: '模型',
              colTier: '档次',
              colCustomer: '客户',
              colTenant: '租户',
              colRecords: '调用',
              colMatchedPct: '匹配率',
              colPortal: 'portal ¥',
              colNewapi: 'new-api ¥',
              colDiff: '差异 ¥',
              colDiffPct: '差异%',
              none: '无 🎉',
          };
}

type Texts = ReturnType<typeof getTexts>;

const fmt = (n: number): string => `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}`;
const fmtSigned = (n: number): string =>
    `${n >= 0 ? '+' : '-'}¥${Math.abs(n).toLocaleString('zh-CN', { maximumFractionDigits: 4 })}`;
const fmtPct = (r: number | null): string => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);
const fmtPctSigned = (r: number | null): string =>
    r === null ? '—' : `${r >= 0 ? '+' : '-'}${(Math.abs(r) * 100).toFixed(1)}%`;

/**
 * Pure presentational reconciliation report (no hooks — props in, markup out).
 * Exported so it can be SSR-smoke-tested with deterministic sample data.
 * Rendered by <ShadowContent /> once data has loaded (records > 0).
 */
export function ShadowReport({ data, t, isDark }: { data: ShadowData; t: Texts; isDark: boolean }) {
    const { summary } = data;
    const threshold = data.bigDiffThreshold;
    const isBig = (r: number | null): boolean => r !== null && Math.abs(r) > threshold;

    const card = isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm';
    const tableWrap = ['overflow-x-auto rounded-xl border', card].join(' ');
    const thCls = `px-4 py-3 font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`;
    const rowBorder = isDark ? 'border-slate-700/50' : 'border-slate-100';
    const labelCls = isDark ? 'text-slate-400' : 'text-slate-500';
    const bigCls = 'text-red-500 font-semibold';
    const okCls = isDark ? 'text-slate-200' : 'text-slate-800';
    const mutedCls = isDark ? 'text-slate-400' : 'text-slate-500';
    const diffNeutral = isDark ? 'text-slate-100' : 'text-slate-900';
    const sectionTitle = `mb-2 text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`;

    return (
        <div className="space-y-6">
            {/* Interpretation / readiness — how to read this report (brief §4) */}
            <div
                className={`rounded-xl border p-4 text-sm ${isDark ? 'border-slate-700 bg-slate-800/40 text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-600'}`}
            >
                <div className={`mb-1 font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{t.howTo}</div>
                <p>{t.interpWhat}</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                    <li>{t.interpReady}</li>
                    <li>{t.interpNotReady}</li>
                </ul>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className={`rounded-xl border p-4 ${card}`}>
                    <div className={`text-xs ${labelCls}`}>{t.portalCost}</div>
                    <div className={`mt-1 text-2xl font-semibold ${okCls}`}>{fmt(summary.costCny)}</div>
                    <div className={`mt-1 text-xs ${mutedCls}`}>
                        {summary.records} {t.records} · {summary.matched} {t.matched} ·{' '}
                        <span className={summary.unmatched > 0 ? 'text-amber-500' : ''}>
                            {summary.unmatched} {t.unmatched}
                        </span>
                    </div>
                </div>
                <div className={`rounded-xl border p-4 ${card}`}>
                    <div className={`text-xs ${labelCls}`}>{t.newapiCost}</div>
                    <div className={`mt-1 text-2xl font-semibold ${okCls}`}>{fmt(summary.newapiCny)}</div>
                    <div className={`mt-1 text-xs ${mutedCls}`}>
                        quota {summary.newapiQuota.toLocaleString('zh-CN')}
                    </div>
                </div>
                <div className={`rounded-xl border p-4 ${card}`}>
                    <div className={`text-xs ${labelCls}`}>{t.diff}</div>
                    <div className={`mt-1 text-2xl font-semibold ${isBig(summary.diffRate) ? bigCls : diffNeutral}`}>
                        {fmtSigned(summary.diffCny)}
                    </div>
                    <div className={`mt-1 text-xs ${isBig(summary.diffRate) ? 'text-red-500' : mutedCls}`}>
                        {fmtPctSigned(summary.diffRate)}
                    </div>
                </div>
                <div className={`rounded-xl border p-4 ${card}`}>
                    <div className={`text-xs ${labelCls}`}>{t.coverage}</div>
                    <div
                        className={`mt-1 text-2xl font-semibold ${summary.coverage !== null && summary.coverage < 0.9 ? 'text-amber-500' : okCls}`}
                    >
                        {fmtPct(summary.coverage)}
                    </div>
                    <div className={`mt-1 text-xs ${mutedCls}`}>
                        {summary.unmatchedNewapiCny > 0 && (
                            <>
                                {t.unmatchedShare} {fmt(summary.unmatchedNewapiCny)}
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Unmatched highlight — the actionable "go price these" list, with how much each costs */}
            <div>
                <div className={sectionTitle}>{t.unmatchedTitle}</div>
                {data.unmatched.length === 0 ? (
                    <div className={`text-sm ${mutedCls}`}>{t.none}</div>
                ) : (
                    <div className="flex flex-wrap gap-2">
                        {data.unmatched.map((u) => (
                            <span
                                key={`${u.model_slug}-${u.tier}`}
                                className={`rounded-lg border px-2 py-1 text-xs ${isDark ? 'border-amber-800 bg-amber-950/30 text-amber-300' : 'border-amber-200 bg-amber-50 text-amber-700'}`}
                            >
                                <span className="font-mono">{u.model_slug}</span> · {u.tier} · {u.records} {t.records} ·{' '}
                                {fmt(u.newapiCny)}
                            </span>
                        ))}
                    </div>
                )}
            </div>

            {/* By model × tier */}
            <div>
                <div className={sectionTitle}>{t.byModel}</div>
                <div className={tableWrap}>
                    <table className="w-full text-sm">
                        <thead>
                            <tr className={`border-b ${rowBorder}`}>
                                <th className={`${thCls} text-left`}>{t.colModel}</th>
                                <th className={`${thCls} text-left`}>{t.colTier}</th>
                                <th className={`${thCls} text-right`}>{t.colRecords}</th>
                                <th className={`${thCls} text-right`}>{t.colMatchedPct}</th>
                                <th className={`${thCls} text-right`}>{t.colPortal}</th>
                                <th className={`${thCls} text-right`}>{t.colNewapi}</th>
                                <th className={`${thCls} text-right`}>{t.colDiff}</th>
                                <th className={`${thCls} text-right`}>{t.colDiffPct}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.byModel.map((m) => {
                                const big = isBig(m.diffRate);
                                return (
                                    <tr key={`${m.model_slug}-${m.tier}`} className={`border-b ${rowBorder}`}>
                                        <td className={`px-4 py-3 font-mono text-xs ${okCls}`}>{m.model_slug}</td>
                                        <td className={`px-4 py-3 ${mutedCls}`}>{m.tier}</td>
                                        <td
                                            className={`px-4 py-3 text-right ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                                        >
                                            {m.records}
                                        </td>
                                        <td
                                            className={`px-4 py-3 text-right ${m.matchedRate !== null && m.matchedRate < 1 ? 'text-amber-500' : mutedCls}`}
                                        >
                                            {fmtPct(m.matchedRate)}
                                        </td>
                                        <td className={`px-4 py-3 text-right ${okCls}`}>{fmt(m.costCny)}</td>
                                        <td className={`px-4 py-3 text-right ${mutedCls}`}>{fmt(m.newapiCny)}</td>
                                        <td className={`px-4 py-3 text-right ${big ? bigCls : okCls}`}>
                                            {fmtSigned(m.diffCny)}
                                        </td>
                                        <td className={`px-4 py-3 text-right ${big ? bigCls : mutedCls}`}>
                                            {fmtPctSigned(m.diffRate)}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* By tenant — only meaningful with >1 tenant (superadmin cross-tenant view). */}
            {data.byTenant.length > 1 && (
                <div>
                    <div className={sectionTitle}>{t.byTenant}</div>
                    <div className={tableWrap}>
                        <table className="w-full text-sm">
                            <thead>
                                <tr className={`border-b ${rowBorder}`}>
                                    <th className={`${thCls} text-left`}>{t.colTenant}</th>
                                    <th className={`${thCls} text-right`}>{t.colRecords}</th>
                                    <th className={`${thCls} text-right`}>{t.colPortal}</th>
                                    <th className={`${thCls} text-right`}>{t.colNewapi}</th>
                                    <th className={`${thCls} text-right`}>{t.colDiff}</th>
                                    <th className={`${thCls} text-right`}>{t.colDiffPct}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.byTenant.map((tn) => {
                                    const big = isBig(tn.diffRate);
                                    return (
                                        <tr key={tn.tenant_id} className={`border-b ${rowBorder}`}>
                                            <td className={`px-4 py-3 ${okCls}`}>
                                                {tn.name ?? tn.slug ?? tn.tenant_id.slice(0, 8)}
                                            </td>
                                            <td
                                                className={`px-4 py-3 text-right ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                                            >
                                                {tn.records}
                                            </td>
                                            <td className={`px-4 py-3 text-right ${okCls}`}>{fmt(tn.costCny)}</td>
                                            <td className={`px-4 py-3 text-right ${mutedCls}`}>{fmt(tn.newapiCny)}</td>
                                            <td className={`px-4 py-3 text-right ${big ? bigCls : okCls}`}>
                                                {fmtSigned(tn.diffCny)}
                                            </td>
                                            <td className={`px-4 py-3 text-right ${big ? bigCls : mutedCls}`}>
                                                {fmtPctSigned(tn.diffRate)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* By customer */}
            <div>
                <div className={sectionTitle}>{t.byCustomer}</div>
                <div className={tableWrap}>
                    <table className="w-full text-sm">
                        <thead>
                            <tr className={`border-b ${rowBorder}`}>
                                <th className={`${thCls} text-left`}>{t.colCustomer}</th>
                                <th className={`${thCls} text-right`}>{t.colRecords}</th>
                                <th className={`${thCls} text-right`}>{t.colPortal}</th>
                                <th className={`${thCls} text-right`}>{t.colNewapi}</th>
                                <th className={`${thCls} text-right`}>{t.colDiff}</th>
                                <th className={`${thCls} text-right`}>{t.colDiffPct}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.byCustomer.map((c) => {
                                const big = isBig(c.diffRate);
                                return (
                                    <tr key={c.user_id} className={`border-b ${rowBorder}`}>
                                        <td className={`px-4 py-3 ${okCls}`}>{c.email ?? c.user_id.slice(0, 8)}</td>
                                        <td
                                            className={`px-4 py-3 text-right ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                                        >
                                            {c.records}
                                        </td>
                                        <td className={`px-4 py-3 text-right ${okCls}`}>{fmt(c.costCny)}</td>
                                        <td className={`px-4 py-3 text-right ${mutedCls}`}>{fmt(c.newapiCny)}</td>
                                        <td className={`px-4 py-3 text-right ${big ? bigCls : okCls}`}>
                                            {fmtSigned(c.diffCny)}
                                        </td>
                                        <td className={`px-4 py-3 text-right ${big ? bigCls : mutedCls}`}>
                                            {fmtPctSigned(c.diffRate)}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}

function ShadowContent() {
    const searchParams = useSearchParams();
    const theme = searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const uiMode = searchParams.get('ui_mode') || 'standalone';
    const locale = resolveLocale(searchParams.get('lang'));
    const isDark = theme === 'dark';
    const isEmbedded = uiMode === 'embedded';
    const t = getTexts(locale);

    const [data, setData] = useState<ShadowData | null>(null);
    const [period, setPeriod] = useState<Period>('30d');
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
    const card = isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm';

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
                <ShadowReport data={data} t={t} isDark={isDark} />
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

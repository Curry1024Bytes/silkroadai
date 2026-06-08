'use client';

import { useSearchParams } from 'next/navigation';
import { useState, useEffect, useCallback, Suspense } from 'react';
import PayPageLayout from '@/components/PayPageLayout';
import { resolveLocale, type Locale } from '@/lib/locale';

// ── Types (mirror /api/admin/billing-shadow, P4b-v2 零售/成本/毛利) ──

interface MarginMoney {
    records: number;
    matchedRecords: number;
    costCoveredRecords: number;
    retailCny: number;
    costCny: number;
    marginCny: number;
    marginRate: number | null;
    costCoverage: number | null;
}
interface ModelRow extends MarginMoney {
    model_slug: string;
    tier: string;
    hasCost: boolean;
}
interface CustomerRow extends MarginMoney {
    user_id: string;
    email: string | null;
}
interface TenantRow extends MarginMoney {
    tenant_id: string;
    slug: string | null;
    name: string | null;
}
interface CostMissingRow {
    model_slug: string;
    tier: string;
    retailCny: number;
    records: number;
}
export interface ShadowData {
    period: string;
    rangeStart: string | null;
    marginYellowThreshold: number;
    summary: MarginMoney;
    byModel: ModelRow[];
    byCustomer: CustomerRow[];
    byTenant: TenantRow[];
    costMissing: CostMissingRow[];
}

type Period = '7d' | '30d' | 'all';
const PERIODS: Period[] = ['7d', '30d', 'all'];

export function getTexts(locale: Locale) {
    return locale === 'en'
        ? {
              title: 'Margin report',
              subtitle: 'Retail vs cost vs margin — portal catalog cost × log tokens. new-api is not involved.',
              shadowWarn: '⚠️ Internal margin board — NOT applied to any customer balance.',
              howTo: 'How to read this',
              interpWhat:
                  'Retail = what we charge the customer (computed at meter time). Cost = upstream wholesale (the cost_cny_per_1m you record in the catalog). Margin = the difference. new-api is not involved — only the token counts come from its logs.',
              interpApprox:
                  'Cost is estimated as (input+output) total tokens × current cost price (single cost field, not split in/out; uses the current price). Margin % is optimistic when cost coverage < 100% — read it alongside coverage + the "cost to fill" list.',
              interpMargin: 'Margin < 20% is amber, < 0 (losing money) is red — watch the red rows.',
              invalidToken: 'Session expired, please sign in again',
              loadFailed: 'Failed to load report',
              loading: 'Loading...',
              empty: 'No usage records yet — the meter polls new-api logs every 10 min.',
              p7d: 'Last 7d',
              p30d: 'Last 30d',
              pall: 'All',
              retail: 'Retail total (¥)',
              cost: 'Cost total (¥)',
              margin: 'Margin',
              coverage: 'Cost coverage',
              calls: 'calls',
              covered: 'priced',
              byModel: 'By model × tier',
              byCustomer: 'By customer',
              byTenant: 'By tenant',
              costMissingTitle: 'Cost to fill (has retail, no cost recorded) — set cost on Pricing',
              colModel: 'Model',
              colTier: 'Tier',
              colCalls: 'Calls',
              colRetail: 'Retail ¥',
              colCost: 'Cost ¥',
              colMargin: 'Margin ¥',
              colMarginRate: 'Margin%',
              colCoverage: 'Cost cov.',
              colCustomer: 'Customer',
              colTenant: 'Tenant',
              none: 'None 🎉',
              dash: '—',
          }
        : {
              title: '对账报表',
              subtitle: '零售 vs 成本 vs 毛利 —— portal 目录成本 × 日志 token。new-api 不参与。',
              shadowWarn: '⚠️ 内部毛利看板 —— 未对任何客户余额生效。',
              howTo: '怎么读这份报表',
              interpWhat:
                  '零售 = 向客户收的(meter 时算)。成本 = 上游拿货(portal 目录里录的 cost_cny_per_1m)。毛利 = 两者差。new-api 不参与,只有 token 数取自它的日志。',
              interpApprox:
                  '成本按 (输入+输出) 总 token × 当前成本价估算(成本单一字段、不分 in/out;用当前价)。毛利率在成本覆盖率<100% 时偏高 —— 配合覆盖率 + 待补成本清单一起看。',
              interpMargin: '毛利率 < 20% 标黄、< 0(在亏钱)标红 —— 重点盯红行。',
              invalidToken: '登录已过期',
              loadFailed: '加载对账报表失败',
              loading: '加载中...',
              empty: '暂无计量记录 —— 计量 job 每 10 分钟轮询一次 new-api 日志。',
              p7d: '近 7 天',
              p30d: '近 30 天',
              pall: '全部',
              retail: '零售总额(¥)',
              cost: '成本总额(¥)',
              margin: '毛利',
              coverage: '成本覆盖率',
              calls: '调用',
              covered: '已录成本',
              byModel: '按模型 × 档次',
              byCustomer: '按客户',
              byTenant: '按租户',
              costMissingTitle: '待补成本(有零售、未录成本)—— 去「定价」页补',
              colModel: '模型',
              colTier: '档次',
              colCalls: '调用',
              colRetail: '零售 ¥',
              colCost: '成本 ¥',
              colMargin: '毛利 ¥',
              colMarginRate: '毛利率',
              colCoverage: '成本覆盖',
              colCustomer: '客户',
              colTenant: '租户',
              none: '无 🎉',
              dash: '—',
          };
}

type Texts = ReturnType<typeof getTexts>;

const fmt = (n: number): string => `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}`;
const fmtPct = (r: number | null): string => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);

/**
 * Pure presentational margin report (no hooks — props in, markup out).
 * Exported so it can be SSR-smoke-tested with deterministic sample data.
 */
export function ShadowReport({ data, t, isDark }: { data: ShadowData; t: Texts; isDark: boolean }) {
    const { summary } = data;
    const threshold = data.marginYellowThreshold;

    const card = isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm';
    const tableWrap = ['overflow-x-auto rounded-xl border', card].join(' ');
    const thCls = `px-4 py-3 font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`;
    const rowBorder = isDark ? 'border-slate-700/50' : 'border-slate-100';
    const labelCls = isDark ? 'text-slate-400' : 'text-slate-500';
    const okCls = isDark ? 'text-slate-200' : 'text-slate-800';
    const mutedCls = isDark ? 'text-slate-400' : 'text-slate-500';
    const sectionTitle = `mb-2 text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`;

    // 毛利率配色:亏钱(<0)红、薄(<阈值)黄、健康中性。无成本(hasCost=false / rate=null)灰。
    const marginColor = (rate: number | null, hasCost: boolean): string => {
        if (!hasCost || rate === null) return mutedCls;
        if (rate < 0) return 'text-red-500 font-semibold';
        if (rate < threshold) return 'text-amber-500';
        return okCls;
    };

    return (
        <div className="space-y-6">
            {/* Interpretation / how to read (brief §2 顶部块 + §4 近似) */}
            <div
                className={`rounded-xl border p-4 text-sm ${isDark ? 'border-slate-700 bg-slate-800/40 text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-600'}`}
            >
                <div className={`mb-1 font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{t.howTo}</div>
                <p>{t.interpWhat}</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                    <li>{t.interpMargin}</li>
                    <li>{t.interpApprox}</li>
                </ul>
            </div>

            {/* Summary cards: 零售 / 成本 / 毛利+率 / 成本覆盖率 */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className={`rounded-xl border p-4 ${card}`}>
                    <div className={`text-xs ${labelCls}`}>{t.retail}</div>
                    <div className={`mt-1 text-2xl font-semibold ${okCls}`}>{fmt(summary.retailCny)}</div>
                    <div className={`mt-1 text-xs ${mutedCls}`}>
                        {summary.records} {t.calls}
                    </div>
                </div>
                <div className={`rounded-xl border p-4 ${card}`}>
                    <div className={`text-xs ${labelCls}`}>{t.cost}</div>
                    <div className={`mt-1 text-2xl font-semibold ${okCls}`}>{fmt(summary.costCny)}</div>
                    <div className={`mt-1 text-xs ${mutedCls}`}>
                        {summary.costCoveredRecords}/{summary.matchedRecords} {t.covered}
                    </div>
                </div>
                <div className={`rounded-xl border p-4 ${card}`}>
                    <div className={`text-xs ${labelCls}`}>{t.margin}</div>
                    <div
                        className={`mt-1 text-2xl font-semibold ${marginColor(summary.marginRate, summary.costCoveredRecords > 0)}`}
                    >
                        {fmt(summary.marginCny)}
                    </div>
                    <div className={`mt-1 text-xs ${marginColor(summary.marginRate, summary.costCoveredRecords > 0)}`}>
                        {fmtPct(summary.marginRate)}
                    </div>
                </div>
                <div className={`rounded-xl border p-4 ${card}`}>
                    <div className={`text-xs ${labelCls}`}>{t.coverage}</div>
                    <div
                        className={`mt-1 text-2xl font-semibold ${summary.costCoverage !== null && summary.costCoverage < 1 ? 'text-amber-500' : okCls}`}
                    >
                        {fmtPct(summary.costCoverage)}
                    </div>
                    <div className={`mt-1 text-xs ${mutedCls}`}>
                        {summary.costCoveredRecords}/{summary.matchedRecords} {t.covered}
                    </div>
                </div>
            </div>

            {/* 待补成本:有零售、未录成本 → 去定价页补(按零售降序) */}
            <div>
                <div className={sectionTitle}>{t.costMissingTitle}</div>
                {data.costMissing.length === 0 ? (
                    <div className={`text-sm ${mutedCls}`}>{t.none}</div>
                ) : (
                    <div className="flex flex-wrap gap-2">
                        {data.costMissing.map((u) => (
                            <span
                                key={`${u.model_slug}-${u.tier}`}
                                className={`rounded-lg border px-2 py-1 text-xs ${isDark ? 'border-amber-800 bg-amber-950/30 text-amber-300' : 'border-amber-200 bg-amber-50 text-amber-700'}`}
                            >
                                <span className="font-mono">{u.model_slug}</span> · {u.tier} · {fmt(u.retailCny)} ·{' '}
                                {u.records} {t.calls}
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
                                <th className={`${thCls} text-right`}>{t.colCalls}</th>
                                <th className={`${thCls} text-right`}>{t.colRetail}</th>
                                <th className={`${thCls} text-right`}>{t.colCost}</th>
                                <th className={`${thCls} text-right`}>{t.colMargin}</th>
                                <th className={`${thCls} text-right`}>{t.colMarginRate}</th>
                                <th className={`${thCls} text-right`}>{t.colCoverage}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.byModel.map((m) => {
                                const mc = marginColor(m.marginRate, m.hasCost);
                                return (
                                    <tr key={`${m.model_slug}-${m.tier}`} className={`border-b ${rowBorder}`}>
                                        <td className={`px-4 py-3 font-mono text-xs ${okCls}`}>{m.model_slug}</td>
                                        <td className={`px-4 py-3 ${mutedCls}`}>{m.tier}</td>
                                        <td
                                            className={`px-4 py-3 text-right ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                                        >
                                            {m.records}
                                        </td>
                                        <td className={`px-4 py-3 text-right ${okCls}`}>{fmt(m.retailCny)}</td>
                                        <td className={`px-4 py-3 text-right ${mutedCls}`}>
                                            {m.hasCost ? fmt(m.costCny) : t.dash}
                                        </td>
                                        <td className={`px-4 py-3 text-right ${mc}`}>
                                            {m.hasCost ? fmt(m.marginCny) : t.dash}
                                        </td>
                                        <td className={`px-4 py-3 text-right ${mc}`}>
                                            {m.hasCost ? fmtPct(m.marginRate) : t.dash}
                                        </td>
                                        <td
                                            className={`px-4 py-3 text-right ${m.costCoverage !== null && m.costCoverage < 1 ? 'text-amber-500' : mutedCls}`}
                                        >
                                            {fmtPct(m.costCoverage)}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* By tenant — 仅 >1 租户时显示(白标经济性) */}
            {data.byTenant.length > 1 && (
                <div>
                    <div className={sectionTitle}>{t.byTenant}</div>
                    <div className={tableWrap}>
                        <table className="w-full text-sm">
                            <thead>
                                <tr className={`border-b ${rowBorder}`}>
                                    <th className={`${thCls} text-left`}>{t.colTenant}</th>
                                    <th className={`${thCls} text-right`}>{t.colCalls}</th>
                                    <th className={`${thCls} text-right`}>{t.colRetail}</th>
                                    <th className={`${thCls} text-right`}>{t.colCost}</th>
                                    <th className={`${thCls} text-right`}>{t.colMargin}</th>
                                    <th className={`${thCls} text-right`}>{t.colMarginRate}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.byTenant.map((tn) => {
                                    const mc = marginColor(tn.marginRate, tn.costCoveredRecords > 0);
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
                                            <td className={`px-4 py-3 text-right ${okCls}`}>{fmt(tn.retailCny)}</td>
                                            <td className={`px-4 py-3 text-right ${mutedCls}`}>{fmt(tn.costCny)}</td>
                                            <td className={`px-4 py-3 text-right ${mc}`}>{fmt(tn.marginCny)}</td>
                                            <td className={`px-4 py-3 text-right ${mc}`}>{fmtPct(tn.marginRate)}</td>
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
                                <th className={`${thCls} text-right`}>{t.colCalls}</th>
                                <th className={`${thCls} text-right`}>{t.colRetail}</th>
                                <th className={`${thCls} text-right`}>{t.colCost}</th>
                                <th className={`${thCls} text-right`}>{t.colMargin}</th>
                                <th className={`${thCls} text-right`}>{t.colMarginRate}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.byCustomer.map((c) => {
                                const mc = marginColor(c.marginRate, c.costCoveredRecords > 0);
                                return (
                                    <tr key={c.user_id} className={`border-b ${rowBorder}`}>
                                        <td className={`px-4 py-3 ${okCls}`}>{c.email ?? c.user_id.slice(0, 8)}</td>
                                        <td
                                            className={`px-4 py-3 text-right ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                                        >
                                            {c.records}
                                        </td>
                                        <td className={`px-4 py-3 text-right ${okCls}`}>{fmt(c.retailCny)}</td>
                                        <td className={`px-4 py-3 text-right ${mutedCls}`}>{fmt(c.costCny)}</td>
                                        <td className={`px-4 py-3 text-right ${mc}`}>{fmt(c.marginCny)}</td>
                                        <td className={`px-4 py-3 text-right ${mc}`}>{fmtPct(c.marginRate)}</td>
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

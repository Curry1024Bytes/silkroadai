'use client';

import { useSearchParams } from 'next/navigation';
import { useState, useEffect, useCallback, useMemo, useRef, Suspense, Fragment } from 'react';
import PayPageLayout from '@/components/PayPageLayout';
import { resolveLocale, type Locale } from '@/lib/locale';
import { deriveTierRows, tierOrder } from '@/lib/admin/pricing-tiers';
import type { BatchCostResult } from '@/lib/admin/batch-cost';
import PricingPublishDialog from '@/components/admin/PricingPublishDialog';
import CostPricingWorkbench from '@/components/admin/CostPricingWorkbench';
import CatalogTieredPriceDetails from '@/components/admin/CatalogTieredPriceDetails';
import { isUniformPricingDetails, parseTieredPricingDetails } from '@/lib/models/tiered-pricing-details';
import { PricingPublishJobs, requestPricingJobAction } from '@/components/admin/PricingPublishJobs';
import type { PricingPublishJob } from '@/lib/admin/pricing-publish-types';

// ── Types (mirror /api/admin/pricing shapes) ──

interface CatalogPrice {
    id: string;
    model_id: string;
    tier: string;
    input_cny_per_1m: string | number | null;
    output_cny_per_1m: string | number | null;
    per_image_cny: string | number | null;
    cost_cny_per_1m: string | number | null;
    effective_from: string;
    created_by: string | null;
    created_at: string;
    billing_details?: unknown;
}

interface ModelWithPrices {
    id: string;
    slug: string;
    display_name: string;
    vendor: string | null;
    modality: string | null;
    enabled: boolean;
    sort_order: number;
    upstream_map: unknown;
    prices: CatalogPrice[];
}

// ── i18n ──

function getTexts(locale: Locale) {
    return locale === 'en'
        ? {
              title: 'Pricing',
              subtitle: 'Reference prices, cost calculation and verified publication in one place',
              invalidToken: 'Session expired, please sign in again',
              loadFailed: 'Failed to load pricing',
              refresh: 'Refresh',
              loading: 'Loading...',
              noModels: 'No models found',
              colModel: 'Model',
              colTier: 'Tier',
              colInput: 'Input (¥/1M)',
              colOutput: 'Output (¥/1M)',
              colImage: 'Request (¥/call)',
              colCost: 'Cost',
              colMargin: 'Margin',
              colActions: 'Actions',
              unpriced: 'Unpriced',
              tierPool: 'Pool',
              tierOfficial: 'Official',
              edit: 'Enter retail price directly',
              history: 'History',
              hide: 'Hide',
              cancel: 'Cancel',
              historyTitle: 'Price history',
              noHistory: 'No price history yet',
              retiredHistory: 'Retired tier history',
              historyOnly: 'No active tier · history only',
              colEffective: 'Catalog effective from',
              // P2.10 batch cost fill
              batchBtn: 'Legacy reference costs',
              batchTitle: 'Legacy reference costs by vendor',
              batchDesc:
                  'Updates reference costs in the legacy catalog only. It does not generate or publish retail prices, or update the saved cost rules above. Cost = current retail × (cost ratio / retail ratio); only models with existing retail prices are included.',
              batchVendor: 'Vendor',
              batchTier: 'Tier (optional)',
              batchAllTiers: 'All tiers',
              batchCostRatio: 'Cost ratio (¥ / official $)',
              batchRetailRatio: 'Retail ratio (¥ / official $)',
              batchFractionLine: (f: string, costPct: string, marginPct: string) =>
                  `fraction ${f} · cost is ${costPct}% of retail · margin ${marginPct}%`,
              batchRetailHint:
                  '⚠️ Retail ratio MUST equal the one used when the retail prices were set — otherwise cost is wrong. Verify the margins in the preview below.',
              batchPreviewBtn: 'Preview',
              batchPreviewing: 'Computing…',
              batchApply: (n: number) => `Apply to ${n}`,
              batchApplying: 'Applying…',
              batchAffected: (a: number, s: number) => `${a} to fill · ${s} skipped`,
              batchNoRetail: 'No retail price — skipped',
              batchColRetail: 'Retail',
              batchColNewCost: 'New cost',
              batchApplied: (n: number) => `✅ Wrote ${n} new cost version row(s). Retail prices unchanged.`,
              batchFailed: 'Batch fill failed',
              batchNoVendors: 'No vendors found',
          }
        : {
              title: '定价',
              subtitle: '查询基础价、计算成本与售价、发布核验，都在这里完成',
              invalidToken: '登录已过期',
              loadFailed: '加载定价失败',
              refresh: '刷新',
              loading: '加载中...',
              noModels: '暂无模型',
              colModel: '模型',
              colTier: '档次',
              colInput: '输入价(¥/1M)',
              colOutput: '输出价(¥/1M)',
              colImage: '按次价(¥/次)',
              colCost: '成本',
              colMargin: '毛利',
              colActions: '操作',
              unpriced: '未定价',
              tierPool: '低价号池',
              tierOfficial: '官方稳定',
              edit: '直接填写售价',
              history: '历史',
              hide: '收起',
              cancel: '取消',
              historyTitle: '改价历史',
              noHistory: '暂无改价历史',
              retiredHistory: '已退役档次历史',
              historyOnly: '无活动档次，仅保留历史',
              colEffective: '目录生效时间',
              // P2.10 批量填成本
              batchBtn: '旧版参考成本',
              batchTitle: '旧版参考成本（按家族）',
              batchDesc:
                  '仅更新旧目录参考成本，不生成或发布售价，也不更新上方已保存的成本规则。成本 = 当前售价 ×（拿货倍率 / 售价倍率）；只处理已有售价的模型。',
              batchVendor: '家族(vendor)',
              batchTier: '档次(可选)',
              batchAllTiers: '全部档次',
              batchCostRatio: '拿货 ratio(¥ / 官方 $)',
              batchRetailRatio: '零售 ratio(¥ / 官方 $)',
              batchFractionLine: (f: string, costPct: string, marginPct: string) =>
                  `fraction ${f} · 成本占零售 ${costPct}% · 毛利 ${marginPct}%`,
              batchRetailHint: '⚠️ 零售 ratio 必须 = 当初设零售价用的那个,否则成本会算错。用下方预览核对毛利。',
              batchPreviewBtn: '预览',
              batchPreviewing: '计算中…',
              batchApply: (n: number) => `确认填入 ${n} 个`,
              batchApplying: '写入中…',
              batchAffected: (a: number, s: number) => `${a} 个将填 · ${s} 个跳过`,
              batchNoRetail: '无零售价,跳过',
              batchColRetail: '现零售',
              batchColNewCost: '算出成本',
              batchApplied: (n: number) => `✅ 已写入 ${n} 个新成本版本行,零售价不变。`,
              batchFailed: '批量填成本失败',
              batchNoVendors: '暂无家族',
          };
}

// ── Money / number helpers ──

/** Decimal fields arrive as string OR number from JSON — coerce + guard null/NaN. */
function toNum(v: string | number | null | undefined): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Format a CNY money value (up to a few decimals, trims trailing zeros). null/NaN → dash. */
function fmtMoney(v: string | number | null | undefined): string {
    const n = toNum(v);
    if (n === null) return '—';
    return `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}`;
}

/** Gross margin % when both retail input and cost present, else dash. */
function fmtMargin(input: string | number | null | undefined, cost: string | number | null | undefined): string {
    const i = toNum(input);
    const c = toNum(cost);
    if (i === null || c === null || i <= 0) return '—';
    return `${(((i - c) / i) * 100).toFixed(0)}%`;
}

/** Beijing-time date display — project gotcha #20 requires explicit timeZone. */
function fmtDate(ts: string): string {
    return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

// ── Per-tier row derivation ──

interface TierRow {
    tier: string;
    current: CatalogPrice | null;
}

// Row derivation lives in @/lib/admin/pricing-tiers (deriveTierRows): only tiers
// in upstream_map are editable. Historical price-only tiers remain audit data.
// Extracted there so it's unit-tested without the 'use client' page.

/** Friendly tier name for the table/modal: pool→低价号池 / official→官方稳定 / else raw. */
function tierLabel(tier: string, t: ReturnType<typeof getTexts>): string {
    if (tier === 'pool') return t.tierPool;
    if (tier === 'official') return t.tierOfficial;
    return tier;
}

// ── Main content ──

function PricingContent() {
    const searchParams = useSearchParams();
    const theme = searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const uiMode = searchParams.get('ui_mode') || 'standalone';
    const locale = resolveLocale(searchParams.get('lang'));
    const isDark = theme === 'dark';
    const isEmbedded = uiMode === 'embedded';
    const t = getTexts(locale);

    const [models, setModels] = useState<ModelWithPrices[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // P2.10 批量填成本 modal
    const [batchOpen, setBatchOpen] = useState(false);

    // Edit modal state
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [editingModel, setEditingModel] = useState<ModelWithPrices | null>(null);
    const [initialTier, setInitialTier] = useState<string | undefined>();
    const [publishJobs, setPublishJobs] = useState<PricingPublishJob[]>([]);
    const [jobBusyId, setJobBusyId] = useState<string | null>(null);
    const [jobError, setJobError] = useState('');
    const fetching = useRef(false);
    const publicationRevision = useRef(0);
    const jobActionLock = useRef(false);

    // ── Fetch ──

    const fetchModels = useCallback(async (quiet = false) => {
        if (fetching.current) return;
        fetching.current = true;
        const revision = publicationRevision.current;
        if (!quiet) setLoading(true);
        setError('');
        try {
            const res = await fetch('/api/admin/pricing');
            if (!res.ok) {
                if (res.status === 401) {
                    setError(t.invalidToken);
                    return;
                }
                throw new Error();
            }
            const data = await res.json();
            if (revision !== publicationRevision.current) return;
            setModels(Array.isArray(data.models) ? data.models : []);
            setPublishJobs(Array.isArray(data.publish_jobs) ? data.publish_jobs : []);
        } catch {
            setError(t.loadFailed);
        } finally {
            fetching.current = false;
            if (!quiet) setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetchModels();
    }, [fetchModels]);

    // Persisted jobs survive a page reload. Poll without replacing the catalog with a spinner.
    useEffect(() => {
        const interval = window.setInterval(() => {
            if (document.visibilityState !== 'hidden') void fetchModels(true);
        }, 5000);
        return () => window.clearInterval(interval);
    }, [fetchModels]);

    const openEditModal = (model: ModelWithPrices, row: TierRow) => {
        setEditingModel(model);
        setInitialTier(row.tier);
        setEditModalOpen(true);
    };
    const closeEditModal = () => {
        setEditModalOpen(false);
        setEditingModel(null);
    };
    const refreshAfterSubmission = (job: PricingPublishJob) => {
        publicationRevision.current++;
        setPublishJobs((previous) => [job, ...previous.filter((row) => row.id !== job.id)]);
        closeEditModal();
        void fetchModels(true);
    };
    const handleJobAction = async (job: PricingPublishJob, action: 'retry' | 'cancel') => {
        if (jobActionLock.current) return;
        jobActionLock.current = true;
        setJobBusyId(job.id);
        setJobError('');
        try {
            const updated = await requestPricingJobAction(job.id, action, locale === 'en');
            publicationRevision.current++;
            setPublishJobs((previous) => previous.map((row) => (row.id === updated.id ? updated : row)));
        } catch (caught) {
            setJobError(
                caught instanceof Error
                    ? caught.message
                    : locale === 'en'
                      ? 'Could not update the task. Refresh to verify its status.'
                      : '任务操作未完成，请刷新核对状态。',
            );
        } finally {
            jobActionLock.current = false;
            setJobBusyId(null);
            void fetchModels(true);
        }
    };

    // ── Styles (mirror dashboard/channels conventions) ──

    const btnBase = [
        'inline-flex items-center rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
        isDark
            ? 'border-slate-600 text-slate-200 hover:bg-slate-800'
            : 'border-slate-300 text-slate-700 hover:bg-slate-100',
    ].join(' ');

    const linkBtn = (color: 'indigo' | 'red' | 'slate') => {
        const map = {
            indigo: isDark ? 'text-indigo-400 hover:bg-indigo-500/20' : 'text-indigo-600 hover:bg-indigo-50',
            red: isDark ? 'text-red-400 hover:bg-red-500/20' : 'text-red-600 hover:bg-red-50',
            slate: isDark ? 'text-slate-300 hover:bg-slate-700/50' : 'text-slate-600 hover:bg-slate-100',
        };
        return ['rounded-md px-2 py-1 text-xs font-medium transition-colors', map[color]].join(' ');
    };

    const thCls = 'px-4 py-3 font-medium';
    const tdMuted = isDark ? 'text-slate-400' : 'text-slate-500';

    // Flatten models → tier rows for rendering (memoized).
    const rendered = useMemo(() => models.map((model) => ({ model, rows: deriveTierRows(model) })), [models]);

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
                    <details className="relative">
                        <summary className={`${btnBase} cursor-pointer`}>
                            {locale === 'en' ? 'Legacy tools' : '历史工具'}
                        </summary>
                        <div
                            className={`absolute right-0 z-10 mt-2 whitespace-nowrap rounded-lg border p-2 shadow-lg ${isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'}`}
                        >
                            <button type="button" onClick={() => setBatchOpen(true)} className={btnBase}>
                                {t.batchBtn}
                            </button>
                        </div>
                    </details>
                    <button type="button" onClick={() => void fetchModels()} className={btnBase}>
                        {t.refresh}
                    </button>
                </div>
            }
        >
            {/* Error banner */}
            {error && (
                <div
                    className={`mb-4 rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/50 text-red-400' : 'border-red-200 bg-red-50 text-red-600'}`}
                >
                    {error}
                    <button onClick={() => setError('')} className="ml-2 opacity-60 hover:opacity-100">
                        ✕
                    </button>
                </div>
            )}

            <div id="pricing-workbench" className="scroll-mt-4">
                <CostPricingWorkbench
                    models={models}
                    isDark={isDark}
                    locale={locale}
                    onPublished={refreshAfterSubmission}
                    onUncertain={() => void fetchModels(true)}
                />
            </div>

            <PricingPublishJobs
                jobs={publishJobs}
                en={locale === 'en'}
                isDark={isDark}
                busyId={jobBusyId}
                error={jobError}
                onAction={handleJobAction}
            />

            <h2 className={`mb-1 text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                {locale === 'en' ? 'Catalog prices and history' : '目录价格与历史'}
            </h2>
            <p className={`mb-3 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {locale === 'en'
                    ? 'These are recorded Portal catalog prices. Verification against new-api is shown in Publication tasks.'
                    : '下方展示 Portal 已记录的目录价格；与 new-api 的核验结果见上方发布任务。'}
            </p>

            {/* Table */}
            <div
                className={[
                    'overflow-x-auto rounded-xl border',
                    isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm',
                ].join(' ')}
            >
                {loading ? (
                    <div className={`py-12 text-center ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>
                        {t.loading}
                    </div>
                ) : rendered.length === 0 ? (
                    <div className={`py-12 text-center ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>
                        <p className="text-base font-medium">{t.noModels}</p>
                    </div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr
                                className={
                                    isDark
                                        ? 'border-b border-slate-700 text-slate-400'
                                        : 'border-b border-slate-200 text-slate-500'
                                }
                            >
                                <th className={`${thCls} text-left`}>{t.colModel}</th>
                                <th className={`${thCls} text-left`}>{t.colTier}</th>
                                <th className={`${thCls} text-right`}>{t.colInput}</th>
                                <th className={`${thCls} text-right`}>{t.colOutput}</th>
                                <th className={`${thCls} text-right`}>{t.colImage}</th>
                                <th className={`${thCls} text-right`}>{t.colCost}</th>
                                <th className={`${thCls} text-right`}>{t.colMargin}</th>
                                <th className={`${thCls} text-right`}>{t.colActions}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rendered.map(({ model, rows }) => (
                                <ModelRows
                                    key={model.id}
                                    model={model}
                                    rows={rows}
                                    isDark={isDark}
                                    tdMuted={tdMuted}
                                    linkBtn={linkBtn}
                                    unpricedLabel={t.unpriced}
                                    editLabel={t.edit}
                                    onEdit={(row) => openEditModal(model, row)}
                                    t={t}
                                />
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {editModalOpen && editingModel && (
                <PricingPublishDialog
                    model={editingModel}
                    initialTier={initialTier}
                    tiers={deriveTierRows(editingModel).map((row) => ({
                        tier: row.tier,
                        current: row.current
                            ? {
                                  input_cny_per_1m: toNum(row.current.input_cny_per_1m),
                                  output_cny_per_1m: toNum(row.current.output_cny_per_1m),
                                  per_image_cny: toNum(row.current.per_image_cny),
                                  cost_cny_per_1m: toNum(row.current.cost_cny_per_1m),
                              }
                            : null,
                    }))}
                    en={locale === 'en'}
                    isDark={isDark}
                    onClose={closeEditModal}
                    onSubmitted={refreshAfterSubmission}
                    onUncertain={() => void fetchModels(true)}
                />
            )}

            {/* ── P2.10 批量填成本 modal ── */}
            {batchOpen && (
                <BatchCostModal
                    isDark={isDark}
                    t={t}
                    models={models}
                    onClose={() => setBatchOpen(false)}
                    onApplied={fetchModels}
                />
            )}
        </PayPageLayout>
    );
}

// ── Per-model price rows and retained history ──

interface ModelRowsProps {
    model: ModelWithPrices;
    rows: TierRow[];
    isDark: boolean;
    tdMuted: string;
    linkBtn: (color: 'indigo' | 'red' | 'slate') => string;
    unpricedLabel: string;
    editLabel: string;
    onEdit: (row: TierRow) => void;
    t: ReturnType<typeof getTexts>;
}

function ModelRows({ model, rows, isDark, tdMuted, linkBtn, unpricedLabel, editLabel, onEdit, t }: ModelRowsProps) {
    const rowBorder = isDark ? 'border-slate-700/50 hover:bg-slate-700/30' : 'border-slate-100 hover:bg-slate-50';
    const [historyView, setHistoryView] = useState<{ kind: 'tier'; tier: string } | { kind: 'retired' } | null>(null);
    const activeTiers = new Set(rows.map((row) => row.tier));
    const retiredPrices = model.prices.filter((price) => !activeTiers.has(price.tier));
    const retiredOpen = historyView?.kind === 'retired' && retiredPrices.length > 0;
    const expandedTier = historyView?.kind === 'tier' && activeTiers.has(historyView.tier) ? historyView.tier : null;
    const modelRowSpan = Math.max(1, rows.length) + (retiredOpen || expandedTier !== null ? 1 : 0);
    const retiredHistoryId = `pricing-retired-history-${model.id}`;

    return (
        <>
            {rows.length === 0 && retiredPrices.length > 0 && (
                <tr className={['border-b', rowBorder].join(' ')}>
                    <td
                        rowSpan={modelRowSpan}
                        className={`px-4 py-3 align-top font-medium ${isDark ? 'text-slate-100' : 'text-slate-900'}`}
                    >
                        <div>{model.display_name}</div>
                        <div className={`text-xs ${tdMuted}`}>{model.slug}</div>
                    </td>
                    <td colSpan={6} className={`px-4 py-3 ${tdMuted}`}>
                        {t.historyOnly}
                    </td>
                    <td className="px-4 py-3 text-right align-top whitespace-nowrap">
                        <div className="inline-grid grid-cols-[auto_4rem] items-center gap-1">
                            <button
                                type="button"
                                aria-expanded={retiredOpen}
                                aria-controls={retiredHistoryId}
                                aria-label={`${t.retiredHistory} · ${model.display_name}`}
                                onClick={() => setHistoryView(retiredOpen ? null : { kind: 'retired' })}
                                className={`col-start-2 ${linkBtn('slate')}`}
                            >
                                {retiredOpen ? t.hide : t.history}
                            </button>
                        </div>
                    </td>
                </tr>
            )}
            {rows.map((row, idx) => {
                const cur = row.current;
                let priceScopeLabel: string | null = null;
                if (cur?.billing_details != null) {
                    try {
                        const details = parseTieredPricingDetails(cur.billing_details)!;
                        priceScopeLabel = isUniformPricingDetails(details)
                            ? t.title === 'Pricing'
                                ? 'Uniform rate'
                                : '统一单价'
                            : t.title === 'Pricing'
                              ? 'First tier'
                              : '首档';
                    } catch {
                        priceScopeLabel = t.title === 'Pricing' ? 'Needs review' : '待核对';
                    }
                }
                const unpriced = cur === null;
                const historyOpen = expandedTier === row.tier;
                const historyId = `pricing-tier-history-${model.id}-${encodeURIComponent(row.tier)}`;
                return (
                    <Fragment key={row.tier}>
                        <tr className={['border-b transition-colors', rowBorder].join(' ')}>
                            {/* Model name spans all tier rows (rendered on the first row only) */}
                            {idx === 0 ? (
                                <td
                                    className={`px-4 py-3 align-top font-medium ${isDark ? 'text-slate-100' : 'text-slate-900'}`}
                                    rowSpan={modelRowSpan}
                                >
                                    <div>{model.display_name}</div>
                                    <div className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                        {model.slug}
                                    </div>
                                    {retiredPrices.length > 0 && (
                                        <button
                                            type="button"
                                            aria-expanded={retiredOpen}
                                            aria-controls={retiredHistoryId}
                                            onClick={() => setHistoryView(retiredOpen ? null : { kind: 'retired' })}
                                            className={`mt-2 text-left text-xs underline underline-offset-2 ${tdMuted}`}
                                        >
                                            {t.retiredHistory}
                                        </button>
                                    )}
                                </td>
                            ) : null}
                            <td className={`px-4 py-3 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                {tierLabel(row.tier, t)}
                                <CatalogTieredPriceDetails raw={cur?.billing_details} en={t.title === 'Pricing'} />
                            </td>
                            {unpriced ? (
                                <td className={`px-4 py-3 text-right ${tdMuted}`} colSpan={5}>
                                    {unpricedLabel}
                                </td>
                            ) : (
                                <>
                                    <td
                                        className={`px-4 py-3 text-right ${isDark ? 'text-slate-200' : 'text-slate-800'}`}
                                    >
                                        {fmtMoney(cur.input_cny_per_1m)}
                                        {priceScopeLabel && (
                                            <div className={`text-xs ${tdMuted}`}>{priceScopeLabel}</div>
                                        )}
                                    </td>
                                    <td
                                        className={`px-4 py-3 text-right ${isDark ? 'text-slate-200' : 'text-slate-800'}`}
                                    >
                                        {fmtMoney(cur.output_cny_per_1m)}
                                        {priceScopeLabel && (
                                            <div className={`text-xs ${tdMuted}`}>{priceScopeLabel}</div>
                                        )}
                                    </td>
                                    <td className={`px-4 py-3 text-right ${tdMuted}`}>
                                        {toNum(cur.per_image_cny) !== null ? fmtMoney(cur.per_image_cny) : '—'}
                                    </td>
                                    <td className={`px-4 py-3 text-right ${tdMuted}`}>
                                        {fmtMoney(cur.cost_cny_per_1m)}
                                    </td>
                                    <td className={`px-4 py-3 text-right ${tdMuted}`}>
                                        {fmtMargin(cur.input_cny_per_1m, cur.cost_cny_per_1m)}
                                    </td>
                                </>
                            )}
                            <td className="px-4 py-3 text-right align-top whitespace-nowrap">
                                <div className="inline-grid grid-cols-[auto_4rem] items-center gap-1">
                                    {cur?.billing_details != null ? (
                                        <a href="#pricing-workbench" className={linkBtn('indigo')}>
                                            {t.title === 'Pricing' ? 'Price by multiplier above' : '上方按倍率定价'}
                                        </a>
                                    ) : (
                                        <button type="button" onClick={() => onEdit(row)} className={linkBtn('indigo')}>
                                            {editLabel}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        aria-expanded={historyOpen}
                                        aria-controls={historyId}
                                        aria-label={`${historyOpen ? t.hide : t.history} · ${model.display_name} · ${tierLabel(row.tier, t)}`}
                                        onClick={() =>
                                            setHistoryView(historyOpen ? null : { kind: 'tier', tier: row.tier })
                                        }
                                        className={linkBtn('slate')}
                                    >
                                        {historyOpen ? t.hide : t.history}
                                    </button>
                                </div>
                            </td>
                        </tr>
                        {historyOpen && (
                            <PriceHistoryRow
                                id={historyId}
                                title={`${t.historyTitle} · ${tierLabel(row.tier, t)}`}
                                prices={model.prices.filter((price) => price.tier === row.tier)}
                                isDark={isDark}
                                t={t}
                            />
                        )}
                    </Fragment>
                );
            })}

            {retiredOpen && (
                <PriceHistoryRow
                    id={retiredHistoryId}
                    title={t.retiredHistory}
                    prices={retiredPrices}
                    isDark={isDark}
                    t={t}
                />
            )}
        </>
    );
}

function PriceHistoryRow({
    id,
    title,
    prices,
    isDark,
    t,
}: {
    id: string;
    title: string;
    prices: CatalogPrice[];
    isDark: boolean;
    t: ReturnType<typeof getTexts>;
}) {
    return (
        <tr className={isDark ? 'bg-slate-900/50' : 'bg-slate-50/70'}>
            <td colSpan={7} className="px-4 py-3">
                <section id={id} aria-label={title}>
                    <div className={`mb-2 text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                        {title}
                    </div>
                    {prices.length === 0 ? (
                        <div className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t.noHistory}</div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className={isDark ? 'text-slate-500' : 'text-slate-400'}>
                                        <th className="px-2 py-1 text-left font-medium">{t.colEffective}</th>
                                        <th className="px-2 py-1 text-left font-medium">{t.colTier}</th>
                                        <th className="px-2 py-1 text-right font-medium">{t.colInput}</th>
                                        <th className="px-2 py-1 text-right font-medium">{t.colOutput}</th>
                                        <th className="px-2 py-1 text-right font-medium">{t.colImage}</th>
                                        <th className="px-2 py-1 text-right font-medium">{t.colCost}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {prices.map((p) => (
                                        <tr key={p.id} className={isDark ? 'text-slate-300' : 'text-slate-600'}>
                                            <td className="px-2 py-1 whitespace-nowrap">{fmtDate(p.effective_from)}</td>
                                            <td className="px-2 py-1">
                                                {p.tier}
                                                <CatalogTieredPriceDetails
                                                    raw={p.billing_details}
                                                    en={t.title === 'Pricing'}
                                                />
                                            </td>
                                            <td className="px-2 py-1 text-right">{fmtMoney(p.input_cny_per_1m)}</td>
                                            <td className="px-2 py-1 text-right">{fmtMoney(p.output_cny_per_1m)}</td>
                                            <td className="px-2 py-1 text-right">
                                                {toNum(p.per_image_cny) !== null ? fmtMoney(p.per_image_cny) : '—'}
                                            </td>
                                            <td className="px-2 py-1 text-right">{fmtMoney(p.cost_cny_per_1m)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>
            </td>
        </tr>
    );
}

// ── P2.10 Batch cost fill modal ──

function BatchCostModal({
    isDark,
    t,
    models,
    onClose,
    onApplied,
}: {
    isDark: boolean;
    t: ReturnType<typeof getTexts>;
    models: ModelWithPrices[];
    onClose: () => void;
    onApplied: () => void;
}) {
    const vendors = useMemo(
        () => Array.from(new Set(models.map((m) => m.vendor).filter((v): v is string => !!v))).sort(),
        [models],
    );
    const [vendor, setVendor] = useState(vendors[0] ?? '');
    const [tier, setTier] = useState(''); // '' = all tiers
    const [costRatio, setCostRatio] = useState('');
    const [retailRatio, setRetailRatio] = useState('');
    const [preview, setPreview] = useState<(BatchCostResult & { written?: number }) | null>(null);
    const [loading, setLoading] = useState(false);
    const [applying, setApplying] = useState(false);
    const [applied, setApplied] = useState<number | null>(null);
    const [error, setError] = useState('');

    // Tiers available for the selected vendor (union via deriveTierRows, stable order).
    const tiers = useMemo(() => {
        const set = new Set<string>();
        for (const m of models) {
            if (m.vendor !== vendor) continue;
            for (const r of deriveTierRows(m)) set.add(r.tier);
        }
        return Array.from(set).sort((a, b) => tierOrder(a) - tierOrder(b) || a.localeCompare(b));
    }, [models, vendor]);

    const cr = toNum(costRatio);
    const rr = toNum(retailRatio);
    const fraction = cr !== null && rr !== null && cr > 0 && rr > 0 ? cr / rr : null;
    const ratiosValid = fraction !== null && !!vendor;

    // Any input change invalidates a stale preview / applied result (so operator can't apply a
    // preview computed for different ratios).
    const invalidate = () => {
        setPreview(null);
        setApplied(null);
    };

    async function callBatch(dryRun: boolean): Promise<(BatchCostResult & { written: number }) | null> {
        const body: Record<string, unknown> = { vendor, cost_ratio: cr, retail_ratio: rr, dryRun };
        if (tier) body.tier = tier;
        try {
            const res = await fetch('/api/admin/pricing/batch-cost', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                if (res.status === 401) {
                    setError(t.invalidToken);
                    return null;
                }
                const d = await res.json().catch(() => ({}));
                setError(typeof d.error === 'string' ? d.error : t.batchFailed);
                return null;
            }
            return (await res.json()) as BatchCostResult & { written: number };
        } catch {
            setError(t.batchFailed);
            return null;
        }
    }

    async function doPreview() {
        if (!ratiosValid) return;
        setError('');
        setApplied(null);
        setLoading(true);
        const r = await callBatch(true);
        if (r) setPreview(r);
        setLoading(false);
    }

    async function doApply() {
        if (!ratiosValid || !preview || preview.affected === 0) return;
        setError('');
        setApplying(true);
        const r = await callBatch(false);
        if (r) {
            setPreview(r);
            setApplied(r.written);
            onApplied();
        }
        setApplying(false);
    }

    const panel = isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white';
    const labelCls = `block text-sm font-medium mb-1 ${isDark ? 'text-slate-300' : 'text-slate-700'}`;
    const fieldCls = [
        'w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50',
        isDark ? 'border-slate-600 bg-slate-700 text-slate-100' : 'border-slate-300 bg-white text-slate-900',
    ].join(' ');
    const thCls = `px-3 py-2 text-left font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`;
    const mutedCls = isDark ? 'text-slate-500' : 'text-slate-400';

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div
                className={['relative w-full max-w-2xl overflow-y-auto rounded-2xl border p-6 shadow-2xl', panel].join(
                    ' ',
                )}
                style={{ maxHeight: '90vh' }}
            >
                <h2 className={`mb-1 text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                    {t.batchTitle}
                </h2>
                <p className={`mb-5 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{t.batchDesc}</p>

                {vendors.length === 0 ? (
                    <div className={`py-6 text-center text-sm ${mutedCls}`}>{t.batchNoVendors}</div>
                ) : (
                    <div className="space-y-4">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div>
                                <label className={labelCls}>{t.batchVendor}</label>
                                <select
                                    value={vendor}
                                    onChange={(e) => {
                                        setVendor(e.target.value);
                                        setTier('');
                                        invalidate();
                                    }}
                                    className={fieldCls}
                                >
                                    {vendors.map((v) => (
                                        <option key={v} value={v}>
                                            {v}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className={labelCls}>{t.batchTier}</label>
                                <select
                                    value={tier}
                                    onChange={(e) => {
                                        setTier(e.target.value);
                                        invalidate();
                                    }}
                                    className={fieldCls}
                                >
                                    <option value="">{t.batchAllTiers}</option>
                                    {tiers.map((tr) => (
                                        <option key={tr} value={tr}>
                                            {tierLabel(tr, t)}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className={labelCls}>{t.batchCostRatio}</label>
                                <input
                                    type="number"
                                    step="0.0001"
                                    min="0"
                                    value={costRatio}
                                    onChange={(e) => {
                                        setCostRatio(e.target.value);
                                        invalidate();
                                    }}
                                    className={fieldCls}
                                />
                            </div>
                            <div>
                                <label className={labelCls}>{t.batchRetailRatio}</label>
                                <input
                                    type="number"
                                    step="0.0001"
                                    min="0"
                                    value={retailRatio}
                                    onChange={(e) => {
                                        setRetailRatio(e.target.value);
                                        invalidate();
                                    }}
                                    className={fieldCls}
                                />
                            </div>
                        </div>

                        {fraction !== null && (
                            <p className={`text-xs ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                                {t.batchFractionLine(
                                    fraction.toFixed(4),
                                    (fraction * 100).toFixed(1),
                                    ((1 - fraction) * 100).toFixed(1),
                                )}
                            </p>
                        )}
                        <p className={`text-xs ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>{t.batchRetailHint}</p>

                        {error && (
                            <div
                                className={`rounded-lg border p-2 text-sm ${isDark ? 'border-red-800 bg-red-950/50 text-red-400' : 'border-red-200 bg-red-50 text-red-600'}`}
                            >
                                {error}
                            </div>
                        )}

                        {/* Preview table */}
                        {preview && (
                            <div>
                                <div className={`mb-1 text-xs ${mutedCls}`}>
                                    {t.batchAffected(preview.affected, preview.skipped)}
                                </div>
                                <div
                                    className={[
                                        'max-h-72 overflow-y-auto rounded-lg border',
                                        isDark ? 'border-slate-700' : 'border-slate-200',
                                    ].join(' ')}
                                >
                                    <table className="w-full text-xs">
                                        <thead className={isDark ? 'bg-slate-900/40' : 'bg-slate-50'}>
                                            <tr>
                                                <th className={thCls}>{t.colModel}</th>
                                                <th className={thCls}>{t.colTier}</th>
                                                <th className={`${thCls} text-right`}>{t.batchColRetail}</th>
                                                <th className={`${thCls} text-right`}>{t.batchColNewCost}</th>
                                                <th className={`${thCls} text-right`}>{t.colMargin}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {preview.rows.map((row) => (
                                                <tr
                                                    key={`${row.model_id}-${row.tier}`}
                                                    className={[
                                                        'border-t',
                                                        isDark ? 'border-slate-700/50' : 'border-slate-100',
                                                        row.skipped ? mutedCls : '',
                                                    ].join(' ')}
                                                >
                                                    <td className="px-3 py-1.5">
                                                        <span className="font-mono">{row.slug}</span>
                                                    </td>
                                                    <td className="px-3 py-1.5">{tierLabel(row.tier, t)}</td>
                                                    <td className="px-3 py-1.5 text-right">
                                                        {row.skipped ? '—' : fmtMoney(row.retail)}
                                                    </td>
                                                    <td className="px-3 py-1.5 text-right">
                                                        {row.skipped ? t.batchNoRetail : fmtMoney(row.newCost)}
                                                    </td>
                                                    <td className="px-3 py-1.5 text-right">
                                                        {row.skipped ? '—' : fmtMargin(row.retail, row.newCost)}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {applied !== null && (
                            <div className={`text-sm ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                                {t.batchApplied(applied)}
                            </div>
                        )}
                    </div>
                )}

                {/* Actions */}
                <div className="mt-6 flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className={[
                            'rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                            isDark ? 'text-slate-400 hover:bg-slate-700' : 'text-slate-600 hover:bg-slate-100',
                        ].join(' ')}
                    >
                        {t.cancel}
                    </button>
                    <button
                        type="button"
                        onClick={doPreview}
                        disabled={!ratiosValid || loading}
                        className={[
                            'rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                            isDark
                                ? 'border-slate-600 text-slate-200 hover:bg-slate-700'
                                : 'border-slate-300 text-slate-700 hover:bg-slate-100',
                        ].join(' ')}
                    >
                        {loading ? t.batchPreviewing : t.batchPreviewBtn}
                    </button>
                    <button
                        type="button"
                        onClick={doApply}
                        disabled={!preview || preview.affected === 0 || applying || applied !== null}
                        className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {applying ? t.batchApplying : t.batchApply(preview?.affected ?? 0)}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Fallback + default export (mirror dashboard page) ──

function PricingPageFallback() {
    const searchParams = useSearchParams();
    const locale = resolveLocale(searchParams.get('lang'));

    return (
        <div className="flex min-h-screen items-center justify-center">
            <div className="text-slate-500">{locale === 'en' ? 'Loading...' : '加载中...'}</div>
        </div>
    );
}

export default function PricingPage() {
    return (
        <Suspense fallback={<PricingPageFallback />}>
            <PricingContent />
        </Suspense>
    );
}

'use client';

import { useSearchParams } from 'next/navigation';
import { useState, useEffect, useCallback, useMemo, Suspense, type ReactNode } from 'react';
import PayPageLayout from '@/components/PayPageLayout';
import { resolveLocale, type Locale } from '@/lib/locale';
import { deriveTierRows, tierOrder } from '@/lib/admin/pricing-tiers';
import type { BatchCostResult } from '@/lib/admin/batch-cost';

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

// Returned by syncModelPriceToNewApi (best-effort sync to new-api).
interface SyncResult {
    ok: boolean;
    skipped?: string;
    channel_id?: number;
    upstream_model?: string;
    ratios?: { model_ratio: number; completion_ratio: number };
    // P2.8 Part B: image models sync to new-api's global ModelPrice (USD/img) instead of mr/cr.
    image?: boolean;
    modelPrice_usd?: number;
    warn?: string;
    error?: string;
}

interface PriceFormData {
    tier: string;
    input_cny_per_1m: string;
    output_cny_per_1m: string;
    per_image_cny: string;
    cost_cny_per_1m: string;
}

// ── i18n ──

function getTexts(locale: Locale) {
    return locale === 'en'
        ? {
              title: 'Pricing',
              subtitle: 'Model × tier retail price (¥/1M token) → auto-sync new-api',
              invalidToken: 'Session expired, please sign in again',
              loadFailed: 'Failed to load pricing',
              saveFailed: 'Failed to save price',
              resyncFailed: 'Failed to resync',
              refresh: 'Refresh',
              loading: 'Loading...',
              noModels: 'No models found',
              colModel: 'Model',
              colTier: 'Tier',
              colInput: 'Input (¥/1M)',
              colOutput: 'Output (¥/1M)',
              colImage: 'Image (¥/img)',
              colCost: 'Cost',
              colMargin: 'Margin',
              colActions: 'Actions',
              unpriced: 'Unpriced',
              tierPool: 'Pool',
              tierOfficial: 'Official',
              edit: 'Edit price',
              resync: 'Resync',
              resyncing: 'Resyncing...',
              history: 'History',
              hide: 'Hide',
              editTitle: 'Edit price',
              fieldTier: 'Tier',
              fieldInput: 'Input price (¥/1M token)',
              fieldOutput: 'Output price (¥/1M token)',
              fieldImage: 'Image price (¥/img, optional)',
              fieldCost: 'Cost (¥/1M token, optional)',
              optional: 'optional',
              ratioHint: (mr: string, cr: string) => `≈ new-api model_ratio ${mr} · completion_ratio ${cr}`,
              cancel: 'Cancel',
              save: 'Save',
              saving: 'Saving...',
              syncOk: (mr: number | string, cr: number | string) =>
                  `✅ Synced ModelRatio (mr=${mr}, cr=${cr}, global — all tiers share it)`,
              syncOkImage: (usd: number | string) => `✅ Synced ModelPrice ($${usd}/img, global — all tiers share it)`,
              syncSkipped: (reason: string) => `↷ Sync skipped: ${reason}`,
              syncFailed: (err: string) => `⚠️ Sync failed: ${err} — click "Resync" to retry`,
              historyTitle: 'Price history',
              noHistory: 'No price history yet',
              colEffective: 'Effective from',
              by: 'by',
              // P2.10 batch cost fill
              batchBtn: 'Batch fill cost',
              batchTitle: 'Batch fill cost by vendor',
              batchDesc:
                  'Cost = retail × (cost ratio / retail ratio). Only models that already have a retail price; retail prices and new-api sync are left untouched.',
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
              subtitle: '模型 × 档次 零售价(¥/1M token)→ 自动同步 new-api',
              invalidToken: '登录已过期',
              loadFailed: '加载定价失败',
              saveFailed: '保存价格失败',
              resyncFailed: '重新同步失败',
              refresh: '刷新',
              loading: '加载中...',
              noModels: '暂无模型',
              colModel: '模型',
              colTier: '档次',
              colInput: '输入价(¥/1M)',
              colOutput: '输出价(¥/1M)',
              colImage: '图片价(¥/张)',
              colCost: '成本',
              colMargin: '毛利',
              colActions: '操作',
              unpriced: '未定价',
              tierPool: '低价号池',
              tierOfficial: '官方稳定',
              edit: '改价',
              resync: '重新同步',
              resyncing: '同步中...',
              history: '历史',
              hide: '收起',
              editTitle: '改价',
              fieldTier: '档次',
              fieldInput: '输入价(¥/1M token)',
              fieldOutput: '输出价(¥/1M token)',
              fieldImage: '图片价(¥/张,可选)',
              fieldCost: '成本(¥/1M token,可选)',
              optional: '可选',
              ratioHint: (mr: string, cr: string) => `≈ new-api model_ratio ${mr} · completion_ratio ${cr}`,
              cancel: '取消',
              save: '保存',
              saving: '保存中...',
              syncOk: (mr: number | string, cr: number | string) =>
                  `✅ 已同步 ModelRatio (mr=${mr}, cr=${cr},全局价 · 各档共享)`,
              syncOkImage: (usd: number | string) => `✅ 已同步 ModelPrice ($${usd}/张,全局价 · 各档共享)`,
              syncSkipped: (reason: string) => `↷ 跳过同步: ${reason}`,
              syncFailed: (err: string) => `⚠️ 同步失败: ${err} — 可点「重新同步」重试`,
              historyTitle: '改价历史',
              noHistory: '暂无改价历史',
              colEffective: '生效时间',
              by: '操作人',
              // P2.10 批量填成本
              batchBtn: '批量填成本',
              batchTitle: '按家族批量填成本',
              batchDesc: '成本 = 零售 × (拿货ratio / 零售ratio)。只填已有零售价的模型;不动零售价、不同步 new-api。',
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

/**
 * Live conversion preview shown in the edit form (mirrors pricing-sync math).
 * GR 原生语义:mr = ¥in ÷ (CHAT_FX × 该档组倍率)。FX/倍率来自 GET 附带的 pricing_context
 * (旧实现硬编码 ÷7,是单位迁移前的口径,已废);context 缺失/该档倍率未知 → 不显示预览。
 */
function computeRatios(
    inputStr: string,
    outputStr: string,
    ctx: { chat_fx: number; group_ratio_by_tier: Record<string, number> } | null,
    tier: string,
): { mr: string; cr: string } | null {
    const input = toNum(inputStr);
    const output = toNum(outputStr);
    if (input === null || input <= 0 || !ctx) return null;
    const gr = ctx.group_ratio_by_tier[tier];
    if (typeof gr !== 'number' || gr <= 0) return null;
    const mr = (input / (ctx.chat_fx * gr)).toFixed(6);
    const cr = output !== null ? (output / input).toFixed(4) : '—';
    return { mr, cr };
}

const emptyForm: PriceFormData = {
    tier: '',
    input_cny_per_1m: '',
    output_cny_per_1m: '',
    per_image_cny: '',
    cost_cny_per_1m: '',
};

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
    // GR 原生语义(2026-07-20):换算预览上下文(FX + 各档组倍率),GET /api/admin/pricing 附带;
    // new-api 不可达时为 null → 预览隐藏(不显示可能错误的数)。
    const [pricingCtx, setPricingCtx] = useState<{
        chat_fx: number;
        image_fx: number;
        group_ratio_by_tier: Record<string, number>;
    } | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // P2.10 批量填成本 modal
    const [batchOpen, setBatchOpen] = useState(false);

    // Edit modal state
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [editingModel, setEditingModel] = useState<ModelWithPrices | null>(null);
    const [form, setForm] = useState<PriceFormData>(emptyForm);
    const [saving, setSaving] = useState(false);
    const [saveSync, setSaveSync] = useState<SyncResult | null>(null);

    // Resync per-model status: modelId → results (or 'loading')
    const [resyncing, setResyncing] = useState<Set<string>>(new Set());
    const [resyncResults, setResyncResults] = useState<Record<string, { tier: string; sync: SyncResult }[]>>({});

    // History expansion: which model ids have history open
    const [historyOpen, setHistoryOpen] = useState<Set<string>>(new Set());

    // ── Fetch ──

    const fetchModels = useCallback(async () => {
        setLoading(true);
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
            setModels(Array.isArray(data.models) ? data.models : []);
            setPricingCtx(data.pricing_context ?? null);
        } catch {
            setError(t.loadFailed);
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetchModels();
    }, [fetchModels]);

    // ── Edit modal ──

    const openEditModal = (model: ModelWithPrices, row: TierRow) => {
        setEditingModel(model);
        setSaveSync(null);
        setForm({
            tier: row.tier,
            input_cny_per_1m:
                row.current?.input_cny_per_1m != null ? String(toNum(row.current.input_cny_per_1m) ?? '') : '',
            output_cny_per_1m:
                row.current?.output_cny_per_1m != null ? String(toNum(row.current.output_cny_per_1m) ?? '') : '',
            per_image_cny: row.current?.per_image_cny != null ? String(toNum(row.current.per_image_cny) ?? '') : '',
            cost_cny_per_1m:
                row.current?.cost_cny_per_1m != null ? String(toNum(row.current.cost_cny_per_1m) ?? '') : '',
        });
        setEditModalOpen(true);
    };

    const closeEditModal = () => {
        setEditModalOpen(false);
        setEditingModel(null);
        setSaveSync(null);
    };

    const formInput = toNum(form.input_cny_per_1m);
    const formOutput = toNum(form.output_cny_per_1m);
    const formImage = toNum(form.per_image_cny);
    // API requires (input AND output) OR per_image.
    const formValid =
        form.tier.trim().length > 0 && ((formInput !== null && formOutput !== null) || formImage !== null);
    const liveRatios = computeRatios(form.input_cny_per_1m, form.output_cny_per_1m, pricingCtx, form.tier.trim());

    const handleSave = async () => {
        if (!editingModel || !formValid) return;
        setSaving(true);
        setError('');
        setSaveSync(null);

        const body: Record<string, unknown> = {
            model_id: editingModel.id,
            tier: form.tier.trim(),
        };
        if (formInput !== null) body.input_cny_per_1m = formInput;
        if (formOutput !== null) body.output_cny_per_1m = formOutput;
        if (formImage !== null) body.per_image_cny = formImage;
        const cost = toNum(form.cost_cny_per_1m);
        if (cost !== null) body.cost_cny_per_1m = cost;

        try {
            const res = await fetch('/api/admin/pricing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                if (res.status === 401) {
                    setError(t.invalidToken);
                    return;
                }
                const data = await res.json().catch(() => ({}));
                setError(data.error || t.saveFailed);
                return;
            }
            const data: { price: CatalogPrice; sync: SyncResult } = await res.json();
            setSaveSync(data.sync ?? null);
            // Re-fetch so the new version row appears; keep modal open to show sync status.
            await fetchModels();
        } catch {
            setError(t.saveFailed);
        } finally {
            setSaving(false);
        }
    };

    // ── Resync ──

    const handleResync = async (model: ModelWithPrices) => {
        setError('');
        setResyncing((prev) => new Set(prev).add(model.id));
        try {
            const res = await fetch(`/api/admin/pricing/${model.id}/resync`, {
                method: 'POST',
                credentials: 'same-origin',
            });
            if (!res.ok) {
                if (res.status === 401) {
                    setError(t.invalidToken);
                    return;
                }
                const data = await res.json().catch(() => ({}));
                setError(data.error || t.resyncFailed);
                return;
            }
            const data: { results: { tier: string; sync: SyncResult }[] } = await res.json();
            setResyncResults((prev) => ({ ...prev, [model.id]: data.results ?? [] }));
        } catch {
            setError(t.resyncFailed);
        } finally {
            setResyncing((prev) => {
                const next = new Set(prev);
                next.delete(model.id);
                return next;
            });
        }
    };

    // ── History toggle ──

    const toggleHistory = (modelId: string) => {
        setHistoryOpen((prev) => {
            const next = new Set(prev);
            if (next.has(modelId)) next.delete(modelId);
            else next.add(modelId);
            return next;
        });
    };

    // ── Sync status renderer (shared by edit modal + resync area) ──

    const renderSyncStatus = (sync: SyncResult, prefix?: string) => {
        if (sync.ok && !sync.skipped) {
            // P2.8 Part B: image models sync to the global ModelPrice (USD/img), not mr/cr.
            const okText = sync.image
                ? t.syncOkImage(sync.modelPrice_usd ?? '?')
                : t.syncOk(sync.ratios?.model_ratio ?? '?', sync.ratios?.completion_ratio ?? '?');
            return (
                <span className={isDark ? 'text-emerald-400' : 'text-emerald-600'}>
                    {prefix}
                    {okText}
                    {sync.warn && (
                        <span className={isDark ? 'block text-amber-400' : 'block text-amber-600'}>⚠️ {sync.warn}</span>
                    )}
                </span>
            );
        }
        if (sync.skipped) {
            return (
                <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>
                    {prefix}
                    {t.syncSkipped(sync.skipped)}
                </span>
            );
        }
        return (
            <span className={isDark ? 'text-red-400' : 'text-red-600'}>
                {prefix}
                {t.syncFailed(sync.error || 'unknown')}
            </span>
        );
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

    const inputCls = [
        'w-full rounded-lg border px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/50',
        isDark
            ? 'border-slate-600 bg-slate-700 text-slate-100 placeholder-slate-400'
            : 'border-slate-300 bg-white text-slate-900 placeholder-slate-400',
    ].join(' ');

    const readonlyInputCls = [
        'w-full rounded-lg border px-3 py-2 text-sm cursor-not-allowed',
        isDark ? 'border-slate-700 bg-slate-800 text-slate-400' : 'border-slate-200 bg-slate-100 text-slate-500',
    ].join(' ');

    const labelCls = ['block text-sm font-medium mb-1', isDark ? 'text-slate-300' : 'text-slate-700'].join(' ');

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
                    <button type="button" onClick={() => setBatchOpen(true)} className={btnBase}>
                        {t.batchBtn}
                    </button>
                    <button type="button" onClick={fetchModels} className={btnBase}>
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
                            {rendered.map(({ model, rows }) => {
                                const isResyncing = resyncing.has(model.id);
                                const rr = resyncResults[model.id];
                                const histOpen = historyOpen.has(model.id);
                                return (
                                    <ModelRows
                                        key={model.id}
                                        model={model}
                                        rows={rows}
                                        isDark={isDark}
                                        tdMuted={tdMuted}
                                        linkBtn={linkBtn}
                                        unpricedLabel={t.unpriced}
                                        editLabel={t.edit}
                                        resyncLabel={isResyncing ? t.resyncing : t.resync}
                                        resyncDisabled={isResyncing}
                                        historyLabel={histOpen ? t.hide : t.history}
                                        onEdit={(row) => openEditModal(model, row)}
                                        onResync={() => handleResync(model)}
                                        onToggleHistory={() => toggleHistory(model.id)}
                                        resyncResults={rr}
                                        renderSyncStatus={renderSyncStatus}
                                        historyOpen={histOpen}
                                        t={t}
                                    />
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            {/* ── Edit price modal ── */}
            {editModalOpen && editingModel && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div
                        className={[
                            'relative w-full max-w-lg overflow-y-auto rounded-2xl border p-6 shadow-2xl',
                            isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white',
                        ].join(' ')}
                        style={{ maxHeight: '90vh' }}
                    >
                        <h2 className={`mb-1 text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                            {t.editTitle}
                        </h2>
                        <p className={`mb-5 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                            {editingModel.display_name}{' '}
                            <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>{editingModel.slug}</span>
                        </p>

                        <div className="space-y-4">
                            <div>
                                <label className={labelCls}>{t.fieldTier}</label>
                                {/* Tier is fixed by the row being edited (a tier from the model's
                                    upstream_map). Read-only so operator can't price an un-routable
                                    tier (P2.7 §2). */}
                                <input
                                    type="text"
                                    value={tierLabel(form.tier, t)}
                                    readOnly
                                    className={readonlyInputCls}
                                />
                            </div>
                            <div>
                                <label className={labelCls}>{t.fieldInput}</label>
                                <input
                                    type="number"
                                    step="0.0001"
                                    min="0"
                                    value={form.input_cny_per_1m}
                                    onChange={(e) => setForm({ ...form, input_cny_per_1m: e.target.value })}
                                    className={inputCls}
                                />
                            </div>
                            <div>
                                <label className={labelCls}>{t.fieldOutput}</label>
                                <input
                                    type="number"
                                    step="0.0001"
                                    min="0"
                                    value={form.output_cny_per_1m}
                                    onChange={(e) => setForm({ ...form, output_cny_per_1m: e.target.value })}
                                    className={inputCls}
                                />
                            </div>

                            {/* Live mr/cr preview so operator sees the new-api conversion before save */}
                            {liveRatios && (
                                <p className={`-mt-2 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                    {t.ratioHint(liveRatios.mr, liveRatios.cr)}
                                </p>
                            )}

                            <div>
                                <label className={labelCls}>{t.fieldImage}</label>
                                <input
                                    type="number"
                                    step="0.0001"
                                    min="0"
                                    value={form.per_image_cny}
                                    onChange={(e) => setForm({ ...form, per_image_cny: e.target.value })}
                                    className={inputCls}
                                    placeholder={t.optional}
                                />
                            </div>
                            <div>
                                <label className={labelCls}>{t.fieldCost}</label>
                                <input
                                    type="number"
                                    step="0.0001"
                                    min="0"
                                    value={form.cost_cny_per_1m}
                                    onChange={(e) => setForm({ ...form, cost_cny_per_1m: e.target.value })}
                                    className={inputCls}
                                    placeholder={t.optional}
                                />
                            </div>
                        </div>

                        {/* Inline sync status after save */}
                        {saveSync && <div className="mt-4 text-sm">{renderSyncStatus(saveSync)}</div>}

                        {/* Actions */}
                        <div className="mt-6 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={closeEditModal}
                                className={[
                                    'rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                                    isDark ? 'text-slate-400 hover:bg-slate-700' : 'text-slate-600 hover:bg-slate-100',
                                ].join(' ')}
                            >
                                {t.cancel}
                            </button>
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={saving || !formValid}
                                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {saving ? t.saving : t.save}
                            </button>
                        </div>
                    </div>
                </div>
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

// ── Per-model rows + inline resync/history sub-rows ──

interface ModelRowsProps {
    model: ModelWithPrices;
    rows: TierRow[];
    isDark: boolean;
    tdMuted: string;
    linkBtn: (color: 'indigo' | 'red' | 'slate') => string;
    unpricedLabel: string;
    editLabel: string;
    resyncLabel: string;
    resyncDisabled: boolean;
    historyLabel: string;
    onEdit: (row: TierRow) => void;
    onResync: () => void;
    onToggleHistory: () => void;
    resyncResults: { tier: string; sync: SyncResult }[] | undefined;
    renderSyncStatus: (sync: SyncResult, prefix?: string) => ReactNode;
    historyOpen: boolean;
    t: ReturnType<typeof getTexts>;
}

function ModelRows({
    model,
    rows,
    isDark,
    tdMuted,
    linkBtn,
    unpricedLabel,
    editLabel,
    resyncLabel,
    resyncDisabled,
    historyLabel,
    onEdit,
    onResync,
    onToggleHistory,
    resyncResults,
    renderSyncStatus,
    historyOpen,
    t,
}: ModelRowsProps) {
    const rowBorder = isDark ? 'border-slate-700/50 hover:bg-slate-700/30' : 'border-slate-100 hover:bg-slate-50';
    const COL_SPAN = 8;

    return (
        <>
            {rows.map((row, idx) => {
                const cur = row.current;
                const unpriced = cur === null;
                return (
                    <tr key={`${model.id}-${row.tier}`} className={['border-b transition-colors', rowBorder].join(' ')}>
                        {/* Model name spans all tier rows (rendered on the first row only) */}
                        {idx === 0 ? (
                            <td
                                className={`px-4 py-3 align-top font-medium ${isDark ? 'text-slate-100' : 'text-slate-900'}`}
                                rowSpan={rows.length}
                            >
                                <div>{model.display_name}</div>
                                <div className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                    {model.slug}
                                </div>
                            </td>
                        ) : null}
                        <td className={`px-4 py-3 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                            {tierLabel(row.tier, t)}
                        </td>
                        {unpriced ? (
                            <td className={`px-4 py-3 text-right ${tdMuted}`} colSpan={5}>
                                {unpricedLabel}
                            </td>
                        ) : (
                            <>
                                <td className={`px-4 py-3 text-right ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                                    {fmtMoney(cur.input_cny_per_1m)}
                                </td>
                                <td className={`px-4 py-3 text-right ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                                    {fmtMoney(cur.output_cny_per_1m)}
                                </td>
                                <td className={`px-4 py-3 text-right ${tdMuted}`}>
                                    {toNum(cur.per_image_cny) !== null ? fmtMoney(cur.per_image_cny) : '—'}
                                </td>
                                <td className={`px-4 py-3 text-right ${tdMuted}`}>{fmtMoney(cur.cost_cny_per_1m)}</td>
                                <td className={`px-4 py-3 text-right ${tdMuted}`}>
                                    {fmtMargin(cur.input_cny_per_1m, cur.cost_cny_per_1m)}
                                </td>
                            </>
                        )}
                        {/* Actions — 改价 is per-tier (every row); 重新同步/历史 are model-level
                            (first row only, so they're not duplicated per tier). */}
                        <td className="px-4 py-3 text-right align-top">
                            <div className="inline-flex flex-wrap justify-end gap-1">
                                <button type="button" onClick={() => onEdit(row)} className={linkBtn('indigo')}>
                                    {editLabel}
                                </button>
                                {idx === 0 && (
                                    <>
                                        <button
                                            type="button"
                                            onClick={onResync}
                                            disabled={resyncDisabled}
                                            className={`${linkBtn('slate')} disabled:opacity-50`}
                                        >
                                            {resyncLabel}
                                        </button>
                                        <button type="button" onClick={onToggleHistory} className={linkBtn('slate')}>
                                            {historyLabel}
                                        </button>
                                    </>
                                )}
                            </div>
                        </td>
                    </tr>
                );
            })}

            {/* Resync results (inline status area) */}
            {resyncResults && resyncResults.length > 0 && (
                <tr className={isDark ? 'bg-slate-800/40' : 'bg-slate-50'}>
                    <td colSpan={COL_SPAN} className="px-4 py-2">
                        <div className="flex flex-col gap-1 text-xs">
                            {resyncResults.map((r) => (
                                <div key={`resync-${model.id}-${r.tier}`}>
                                    {renderSyncStatus(r.sync, `${r.tier}: `)}
                                </div>
                            ))}
                        </div>
                    </td>
                </tr>
            )}

            {/* History timeline (all tiers, newest first) */}
            {historyOpen && (
                <tr className={isDark ? 'bg-slate-900/50' : 'bg-slate-50/70'}>
                    <td colSpan={COL_SPAN} className="px-4 py-3">
                        <div className={`mb-2 text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                            {t.historyTitle}
                        </div>
                        {model.prices.length === 0 ? (
                            <div className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                {t.noHistory}
                            </div>
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
                                        {model.prices.map((p) => (
                                            <tr key={p.id} className={isDark ? 'text-slate-300' : 'text-slate-600'}>
                                                <td className="px-2 py-1 whitespace-nowrap">
                                                    {fmtDate(p.effective_from)}
                                                </td>
                                                <td className="px-2 py-1">{p.tier}</td>
                                                <td className="px-2 py-1 text-right">{fmtMoney(p.input_cny_per_1m)}</td>
                                                <td className="px-2 py-1 text-right">
                                                    {fmtMoney(p.output_cny_per_1m)}
                                                </td>
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
                    </td>
                </tr>
            )}
        </>
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

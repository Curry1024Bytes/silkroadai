'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import PricingReferencePicker, { type PricingReferenceSelection } from '@/components/admin/PricingReferencePicker';
import CatalogTieredPriceDetails from '@/components/admin/CatalogTieredPriceDetails';
import { pricingNumberFromInput, pricingNumberInput } from '@/components/admin/pricing-number-input';
import type { BasePrice } from '@/lib/admin/pricing-simple-core';
import type {
    CellStatus,
    LoggedBillLookup,
    RuntimeCheck,
    SaveResult,
    SimplePreview,
    SimplePricingView,
    SimpleTier,
    SimpleUpstreamModel,
} from '@/lib/admin/pricing-simple';
import {
    cnyMatches,
    estimateBill,
    margin,
    purchaseRateFromQuote,
    quotaMatches,
    type BillLine,
} from '@/lib/admin/pricing-bill-check';
import type { CatalogAmounts, CatalogDiff, CatalogDiffField } from '@/lib/admin/pricing-simple-core';

type Tab = 'tiers' | 'models' | 'overview' | 'check';

interface Props {
    isDark: boolean;
    en: boolean;
}

class ApiError extends Error {}

async function api<T>(body?: Record<string, unknown>): Promise<T> {
    const response = await fetch('/api/admin/pricing/simple', {
        method: body ? 'POST' : 'GET',
        cache: 'no-store',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const data = (await response.json().catch(() => null)) as (T & { message?: string }) | null;
    if (!response.ok || !data)
        throw new ApiError(
            data?.message ?? (response.status === 401 ? '登录已过期，请重新登录。' : '请求失败，请稍后重试。'),
        );
    return data;
}

function money(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    return `¥${Number(value.toFixed(4))}`;
}

function amountsLabel(amounts: CatalogAmounts | null, en: boolean): string {
    if (!amounts) return '—';
    if (amounts.per_image_cny !== null) return `${money(amounts.per_image_cny)}${en ? '/call' : '/次'}`;
    return `${money(amounts.input_cny_per_1m)} / ${money(amounts.output_cny_per_1m)}`;
}

const DIFF_FIELD_LABEL: Record<CatalogDiffField, [string, string]> = {
    input: ['输入', 'Input'],
    output: ['输出', 'Output'],
    per_call: ['按次', 'Per call'],
    cache_read: ['缓存读', 'Cache read'],
    cache_write: ['缓存写', 'Cache write'],
    cache_write_1h: ['缓存写 1h', 'Cache write 1h'],
    tier_count: ['阶梯档数', 'Tier count'],
    bound: ['档位上限', 'Tier bound'],
};

/** e.g. "第2档 缓存读:目录 — → 实际 ¥0.16" */
function diffLabel(diff: CatalogDiff, en: boolean): string {
    const count = diff.field === 'tier_count';
    const bound = diff.field === 'bound';
    const value = (v: number | null) =>
        v === null ? (bound ? (en ? 'open' : '不封顶') : '—') : count || bound ? v.toLocaleString('en-US') : money(v);
    const tier = diff.tier === null ? '' : en ? `Tier ${diff.tier + 1} ` : `第${diff.tier + 1}档 `;
    return en
        ? `${tier}${DIFF_FIELD_LABEL[diff.field][1]}: catalog ${value(diff.catalog)} → billed ${value(diff.expected)}`
        : `${tier}${DIFF_FIELD_LABEL[diff.field][0]}:目录 ${value(diff.catalog)} → 实际 ${value(diff.expected)}`;
}

const STATUS_LABEL: Record<CellStatus, [string, string]> = {
    ok: ['一致', 'OK'],
    mismatch: ['目录待同步', 'Catalog stale'],
    missing: ['目录无记录', 'No catalog row'],
    unpriced: ['new-api 未定价', 'Unpriced in new-api'],
    no_ratio: ['档次无倍率', 'Tier has no ratio'],
    invalid: ['配置无法解析', 'Unreadable config'],
};

export default function SimplePricing({ isDark, en }: Props) {
    const [tab, setTab] = useState<Tab>('tiers');
    const [view, setView] = useState<SimplePricingView | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setView(await api<SimplePricingView>());
            setError('');
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : '加载失败。');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
        void load();
    }, [load]);

    const saved = (result: SaveResult) => {
        setNotice(
            result.unchanged && result.catalog_rows === 0
                ? en
                    ? 'Nothing changed.'
                    : '没有变化。'
                : en
                  ? `Saved. new-api keys written: ${result.written_keys.join(', ') || 'none'}; catalog rows: ${result.catalog_rows}.`
                  : `已保存并核对。写入 new-api:${result.written_keys.join('、') || '无'};更新目录价 ${result.catalog_rows} 行。`,
        );
        void load();
    };

    const card = isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm';
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const tabs: Array<[Tab, string, string]> = [
        ['tiers', '档次与利润', 'Tiers & margin'],
        ['models', '模型基础价', 'Model base prices'],
        ['overview', '价格总览', 'Price overview'],
        ['check', '计费核对', 'Bill check'],
    ];
    const mismatches = useMemo(
        () =>
            view?.models.reduce((sum, model) => sum + model.cells.filter((cell) => cell.status !== 'ok').length, 0) ??
            0,
        [view],
    );

    return (
        <div className="space-y-4">
            <p className={`text-xs ${muted}`}>
                {en
                    ? 'Customer price = model base price (official $) × sell rate; our cost = base price × buy rate. Saving a price writes new-api immediately and verifies it.'
                    : '客户价 = 模型基础价(官方 $)× 售价率；我们的成本 = 基础价 × 进货率。改价保存即写入 new-api 并回读核对，立刻生效。'}
            </p>
            {error && (
                <div
                    role="alert"
                    className={`rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/50 text-red-400' : 'border-red-200 bg-red-50 text-red-600'}`}
                >
                    {error}
                </div>
            )}
            {notice && (
                <div
                    role="status"
                    className={`rounded-lg border p-3 text-sm ${isDark ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}
                >
                    {notice}
                    <button type="button" onClick={() => setNotice('')} className="ml-2 opacity-60 hover:opacity-100">
                        ✕
                    </button>
                </div>
            )}
            <div role="tablist" className="flex flex-wrap gap-2">
                {tabs.map(([key, zh, english]) => (
                    <button
                        key={key}
                        type="button"
                        role="tab"
                        aria-selected={tab === key}
                        onClick={() => setTab(key)}
                        className={[
                            'rounded-lg border px-3 py-1.5 text-sm font-medium',
                            tab === key
                                ? 'border-indigo-500 bg-indigo-600 text-white'
                                : isDark
                                  ? 'border-slate-600 text-slate-200 hover:bg-slate-800'
                                  : 'border-slate-300 text-slate-700 hover:bg-slate-100',
                        ].join(' ')}
                    >
                        {en ? english : zh}
                        {key === 'overview' && mismatches > 0 ? ` · ${mismatches}` : ''}
                    </button>
                ))}
                <button
                    type="button"
                    onClick={() => void load()}
                    className={`ml-auto rounded-lg border px-3 py-1.5 text-sm ${isDark ? 'border-slate-600 text-slate-200' : 'border-slate-300 text-slate-700'}`}
                >
                    {en ? 'Refresh' : '刷新'}
                </button>
            </div>
            <div className={`rounded-xl border p-4 ${card}`}>
                {loading && !view ? (
                    <p className={`py-8 text-center ${muted}`}>{en ? 'Loading…' : '加载中…'}</p>
                ) : !view ? null : tab === 'tiers' ? (
                    <TiersPanel
                        view={view}
                        en={en}
                        isDark={isDark}
                        onSaved={saved}
                        onError={setError}
                        onReload={() => void load()}
                    />
                ) : tab === 'models' ? (
                    <ModelsPanel view={view} en={en} isDark={isDark} onSaved={saved} onError={setError} />
                ) : tab === 'check' ? (
                    <BillCheckPanel view={view} en={en} isDark={isDark} onSaved={saved} onError={setError} />
                ) : (
                    <OverviewPanel view={view} en={en} isDark={isDark} onSaved={saved} onError={setError} />
                )}
            </div>
        </div>
    );
}

interface PanelProps {
    view: SimplePricingView;
    en: boolean;
    isDark: boolean;
    onSaved: (result: SaveResult) => void;
    onError: (message: string) => void;
}

function inputCls(isDark: boolean) {
    return `w-28 rounded border px-2 py-1 text-sm ${isDark ? 'border-slate-600 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white'}`;
}

function buttonCls(kind: 'primary' | 'plain', isDark: boolean) {
    return kind === 'primary'
        ? 'rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50'
        : `rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${isDark ? 'border-slate-600 text-slate-200' : 'border-slate-300 text-slate-700'}`;
}

function PreviewBox({
    preview,
    en,
    isDark,
    busy,
    onConfirm,
    onCancel,
}: {
    preview: SimplePreview;
    en: boolean;
    isDark: boolean;
    busy: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const changed = preview.rows.filter((row) => amountsLabel(row.before, en) !== amountsLabel(row.after, en));
    return (
        <div
            className={`mt-3 rounded-lg border p-3 text-sm ${isDark ? 'border-amber-700 bg-amber-950/20' : 'border-amber-200 bg-amber-50'}`}
        >
            {preview.unchanged ? (
                <p>{en ? 'new-api already has these values.' : 'new-api 已经是这个值，无需写入。'}</p>
            ) : (
                <p className="font-medium">
                    {en ? `${changed.length} customer price(s) will change:` : `将影响 ${changed.length} 个客户价:`}
                </p>
            )}
            {preview.warnings.map((warning) => (
                <p key={warning} className="mt-1 text-amber-600">
                    ⚠ {warning}
                </p>
            ))}
            {changed.length > 0 && (
                <table className="mt-2 w-full text-xs">
                    <thead className={muted}>
                        <tr>
                            <th className="py-1 text-left">{en ? 'Model' : '模型'}</th>
                            <th className="py-1 text-left">{en ? 'Tier' : '档次'}</th>
                            <th className="py-1 text-right">{en ? 'Before (in/out per 1M)' : '原价(入/出 每百万)'}</th>
                            <th className="py-1 text-right">{en ? 'After' : '新价'}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {changed.map((row) => (
                            <tr key={`${row.model_id}:${row.tier}`}>
                                <td className="py-1">{row.display_name}</td>
                                <td className="py-1">{row.tier}</td>
                                <td className="py-1 text-right">{amountsLabel(row.before, en)}</td>
                                <td className="py-1 text-right font-medium">{amountsLabel(row.after, en)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <div className="mt-3 flex gap-2">
                <button type="button" className={buttonCls('primary', isDark)} disabled={busy} onClick={onConfirm}>
                    {busy ? (en ? 'Saving…' : '保存中…') : en ? 'Confirm and save' : '确认保存'}
                </button>
                <button type="button" className={buttonCls('plain', isDark)} disabled={busy} onClick={onCancel}>
                    {en ? 'Cancel' : '取消'}
                </button>
            </div>
        </div>
    );
}

// ── Tiers ──

function percent(value: number): string {
    return `${Number((value * 100).toFixed(1))}%`;
}

function MarginLabel({ purchase, sell, en }: { purchase: number | null; sell: number | null; en: boolean }) {
    const result = margin(purchase, sell);
    if (!result) return <span className="text-slate-400">—</span>;
    return (
        <span className={result.gross < 0 ? 'text-red-500' : ''}>
            ×{Number(result.multiple.toFixed(2))}
            <span className="ml-1 text-xs opacity-70">
                {en ? 'margin' : '毛利'} {percent(result.gross)}
            </span>
        </span>
    );
}

function PurchaseRateEditor({
    tier,
    en,
    isDark,
    onSaved,
    onError,
    onClose,
}: {
    tier: SimpleTier;
    en: boolean;
    isDark: boolean;
    onSaved: () => void;
    onError: (message: string) => void;
    onClose: () => void;
}) {
    const [rate, setRate] = useState(pricingNumberInput(tier.purchase_rate));
    const [credits, setCredits] = useState('');
    const [channelRatio, setChannelRatio] = useState('');
    const [busy, setBusy] = useState(false);
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const quoted = purchaseRateFromQuote(Number(credits), Number(channelRatio));
    const draft = pricingNumberFromInput(rate, tier.purchase_rate ?? undefined);

    const save = async (value: number | null) => {
        if (value !== null && !(value > 0)) return onError(en ? 'Enter a positive rate.' : '请输入大于 0 的进货率。');
        setBusy(true);
        onError('');
        try {
            await api({ action: 'save_purchase_rate', group_id: tier.id, purchase_rate: value });
            onSaved();
        } catch (caught) {
            onError(caught instanceof Error ? caught.message : '保存失败。');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div
            className={`mt-3 space-y-3 rounded-lg border p-3 text-sm ${isDark ? 'border-slate-600 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`}
        >
            <p className="font-medium">
                {en ? `Buy rate · ${tier.display_name}` : `进货率 · ${tier.display_name}`}
                <span className={`ml-2 text-xs font-normal ${muted}`}>
                    {en
                        ? '¥ we pay the upstream per official $1. Used for margins only; never changes billing.'
                        : '上游每 1 美元官方价我们付多少元。只用于算利润和核对上游，不影响扣费。多个上游填最贵的。'}
                </span>
            </p>
            <div className="flex flex-wrap items-end gap-3">
                <Field
                    label={en ? 'Buy rate (¥/$1)' : '进货率(¥/$1)'}
                    value={rate}
                    onChange={setRate}
                    isDark={isDark}
                />
                <span className={`pb-1 text-xs ${muted}`}>{en ? 'or from a quote:' : '或按上游报价换算:'}</span>
                <Field
                    label={en ? 'Credits per ¥1 recharge' : '充值 ¥1 得额度'}
                    value={credits}
                    onChange={setCredits}
                    isDark={isDark}
                />
                <Field
                    label={en ? 'Channel ratio' : '渠道倍率'}
                    value={channelRatio}
                    onChange={setChannelRatio}
                    isDark={isDark}
                />
                <button
                    type="button"
                    className={buttonCls('plain', isDark)}
                    disabled={quoted === null}
                    onClick={() => setRate(pricingNumberInput(Number(quoted!.toFixed(6))))}
                >
                    {quoted === null ? (en ? 'Use' : '填入') : `${en ? 'Use' : '填入'} ${Number(quoted.toFixed(6))}`}
                </button>
            </div>
            <p className={`text-xs ${muted}`}>
                {en ? 'With sell rate' : '按当前售价率'} {tier.ratio ?? '?'}:{' '}
                <MarginLabel purchase={draft} sell={tier.ratio} en={en} />
            </p>
            <div className="flex gap-2">
                <button
                    type="button"
                    className={buttonCls('primary', isDark)}
                    disabled={busy || draft === null}
                    onClick={() => void save(draft)}
                >
                    {busy ? (en ? 'Saving…' : '保存中…') : en ? 'Save' : '保存'}
                </button>
                {tier.purchase_rate !== null && (
                    <button
                        type="button"
                        className={buttonCls('plain', isDark)}
                        disabled={busy}
                        onClick={() => void save(null)}
                    >
                        {en ? 'Clear' : '清空'}
                    </button>
                )}
                <button type="button" className={buttonCls('plain', isDark)} disabled={busy} onClick={onClose}>
                    {en ? 'Cancel' : '取消'}
                </button>
            </div>
        </div>
    );
}

function TiersPanel({ view, en, isDark, onSaved, onError, onReload }: PanelProps & { onReload: () => void }) {
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [preview, setPreview] = useState<{ id: string; ratio: number; data: SimplePreview } | null>(null);
    const [editing, setEditing] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const editingTier = view.tiers.find((tier) => tier.id === editing) ?? null;

    const requestPreview = async (id: string) => {
        const ratio = Number(drafts[id]);
        if (!Number.isFinite(ratio) || ratio <= 0)
            return onError(en ? 'Enter a positive ratio.' : '请输入大于 0 的倍率。');
        setBusy(true);
        onError('');
        try {
            const { preview: data } = await api<{ preview: SimplePreview }>({
                action: 'preview_tier',
                group_id: id,
                ratio,
            });
            setEditing(null);
            setPreview({ id, ratio, data });
        } catch (caught) {
            onError(caught instanceof Error ? caught.message : '预览失败。');
        } finally {
            setBusy(false);
        }
    };
    const confirm = async () => {
        if (!preview) return;
        const tier = view.tiers.find((row) => row.id === preview.id);
        setBusy(true);
        onError('');
        try {
            const { result } = await api<{ result: SaveResult }>({
                action: 'save_tier',
                group_id: preview.id,
                ratio: preview.ratio,
                expected_ratio: tier?.ratio ?? null,
            });
            setPreview(null);
            setDrafts((previous) => ({ ...previous, [preview.id]: '' }));
            onSaved(result);
        } catch (caught) {
            onError(caught instanceof Error ? caught.message : '保存失败。');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div>
            <p className={`mb-3 text-xs ${muted}`}>
                {en
                    ? 'Buy rate = ¥ we pay per official $1; sell rate = ¥ the tier charges per official $1 (new-api group ratio). Profit multiple = sell ÷ buy.'
                    : '进货率 = 上游每 1 美元官方价我们付多少元(只记账，不影响扣费);售价率 = 该档每 1 美元官方价收客户多少元(即 new-api 分组倍率，改了立刻生效)。利润倍数 = 售价率 ÷ 进货率。'}
            </p>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead className={muted}>
                        <tr>
                            <th className="py-2 text-left">{en ? 'Tier' : '档次'}</th>
                            <th className="py-2 text-right">{en ? 'Keys / custom' : '在用 Key / 专属'}</th>
                            <th className="py-2 text-right">{en ? 'Buy rate' : '进货率'}</th>
                            <th className="py-2 text-right">{en ? 'Sell rate' : '售价率'}</th>
                            <th className="py-2 text-right">{en ? 'Profit' : '利润'}</th>
                            <th className="py-2 text-right">{en ? 'New sell rate' : '改售价率'}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {view.tiers.map((tier) => (
                            <tr
                                key={tier.id}
                                className={isDark ? 'border-t border-slate-700' : 'border-t border-slate-100'}
                            >
                                <td className="py-2">
                                    <div className="font-medium">{tier.display_name}</div>
                                    <div className={`text-xs ${muted}`}>
                                        {tier.key} · new-api {tier.newapi_group} · {tier.model_count}{' '}
                                        {en ? 'models' : '个模型'}
                                    </div>
                                </td>
                                <td className="py-2 text-right">
                                    {tier.active_keys}
                                    <span className={muted}> / {tier.customer_overrides}</span>
                                </td>
                                <td className="py-2 text-right">
                                    <button
                                        type="button"
                                        className="underline decoration-dotted underline-offset-2"
                                        onClick={() => {
                                            setPreview(null);
                                            setEditing(tier.id);
                                        }}
                                    >
                                        {tier.purchase_rate ?? (
                                            <span className="text-amber-500">{en ? 'set' : '未填'}</span>
                                        )}
                                    </button>
                                </td>
                                <td className="py-2 text-right font-medium">
                                    {tier.ratio ?? <span className="text-red-500">{en ? 'missing' : '缺失'}</span>}
                                </td>
                                <td className="py-2 text-right">
                                    <MarginLabel purchase={tier.purchase_rate} sell={tier.ratio} en={en} />
                                </td>
                                <td className="py-2 text-right">
                                    <div className="flex justify-end gap-2">
                                        <input
                                            aria-label={`${tier.key} ratio`}
                                            inputMode="decimal"
                                            className={inputCls(isDark)}
                                            value={drafts[tier.id] ?? ''}
                                            placeholder={tier.ratio === null ? '' : String(tier.ratio)}
                                            onChange={(event) =>
                                                setDrafts({ ...drafts, [tier.id]: event.target.value })
                                            }
                                        />
                                        <button
                                            type="button"
                                            className={buttonCls('plain', isDark)}
                                            disabled={busy || !drafts[tier.id]}
                                            onClick={() => void requestPreview(tier.id)}
                                        >
                                            {en ? 'Preview' : '预览'}
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {editingTier && (
                <PurchaseRateEditor
                    key={editingTier.id}
                    tier={editingTier}
                    en={en}
                    isDark={isDark}
                    onError={onError}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        onReload();
                    }}
                />
            )}
            {preview && (
                <PreviewBox
                    preview={preview.data}
                    en={en}
                    isDark={isDark}
                    busy={busy}
                    onConfirm={() => void confirm()}
                    onCancel={() => setPreview(null)}
                />
            )}
        </div>
    );
}

// ── Models ──

interface TierDraft {
    max: string;
    inclusive: boolean;
    input: string;
    output: string;
    cache_read: string;
    cache_write: string;
    cache_write_1h: string;
}

interface ModelDraft {
    mode: BasePrice['mode'];
    input: string;
    output: string;
    cache_read: string;
    cache_write: string;
    price: string;
    tiers: TierDraft[];
}

const text = pricingNumberInput;

function draftFrom(base: BasePrice | null, modality: string): ModelDraft {
    const empty: ModelDraft = {
        mode: modality === 'image' || modality === 'video' ? 'per_call' : 'token',
        input: '',
        output: '',
        cache_read: '',
        cache_write: '',
        price: '',
        tiers: [],
    };
    if (!base) return empty;
    if (base.mode === 'token')
        return {
            ...empty,
            mode: 'token',
            input: text(base.input),
            output: text(base.output),
            cache_read: text(base.cache_read),
            cache_write: text(base.cache_write),
        };
    if (base.mode === 'per_call') return { ...empty, mode: 'per_call', price: text(base.price) };
    return {
        ...empty,
        mode: 'tiered',
        tiers: base.tiers.map((tier) => ({
            max: tier.max_input_tokens === null ? '' : String(tier.max_input_tokens),
            inclusive: tier.max_inclusive,
            input: text(tier.rates.input),
            output: text(tier.rates.output),
            cache_read: text(tier.rates.cache_read),
            cache_write: text(tier.rates.cache_write),
            cache_write_1h: text(tier.rates.cache_write_1h),
        })),
    };
}

function baseFrom(draft: ModelDraft): BasePrice {
    const value = (raw: string) => pricingNumberFromInput(raw) ?? Number.NaN;
    const optional = (raw: string) => (raw.trim() ? value(raw) : null);
    if (draft.mode === 'per_call') return { mode: 'per_call', price: value(draft.price) };
    if (draft.mode === 'token')
        return {
            mode: 'token',
            input: value(draft.input),
            output: value(draft.output),
            cache_read: optional(draft.cache_read),
            cache_write: optional(draft.cache_write),
        };
    return {
        mode: 'tiered',
        tiers: draft.tiers.map((tier, index) => ({
            max_input_tokens: index === draft.tiers.length - 1 ? null : Math.round(value(tier.max)),
            max_inclusive: index === draft.tiers.length - 1 ? false : tier.inclusive,
            rates: {
                input: value(tier.input),
                output: value(tier.output),
                cache_read: optional(tier.cache_read),
                cache_write: optional(tier.cache_write),
                cache_write_1h: optional(tier.cache_write_1h),
            },
        })),
    };
}

function baseSummary(base: BasePrice | null, en: boolean): string {
    if (!base) return en ? 'Unpriced' : '未定价';
    if (base.mode === 'per_call') return `$${base.price}${en ? '/call' : '/次'}`;
    if (base.mode === 'token') return `$${base.input} / $${base.output}`;
    return `${en ? 'Tiered' : '阶梯'} ×${base.tiers.length} · $${base.tiers[0].rates.input} / $${base.tiers[0].rates.output}`;
}

function ModelsPanel({ view, en, isDark, onSaved, onError }: PanelProps) {
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState<string | null>(null);
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const models = view.upstream_models.filter((model) => {
        const q = query.trim().toLowerCase();
        return (
            !q ||
            model.name.toLowerCase().includes(q) ||
            model.used_by.some(
                (use) => use.display_name.toLowerCase().includes(q) || use.slug.toLowerCase().includes(q),
            )
        );
    });
    const current = view.upstream_models.find((model) => model.name === selected) ?? null;

    return (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div>
                <input
                    aria-label="search models"
                    className={`mb-3 w-full rounded border px-2 py-1.5 text-sm ${isDark ? 'border-slate-600 bg-slate-900 text-slate-100' : 'border-slate-300'}`}
                    placeholder={en ? 'Search model' : '搜索模型'}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                />
                <p className={`mb-2 text-xs ${muted}`}>
                    {en
                        ? 'Base price in official $ (per 1M tokens, or per call). One price per upstream model, shared by every tier.'
                        : '基础价按官方美元填写(每百万 token 或每次)。每个上游模型只有一个基础价，所有档次共用。'}
                </p>
                <ul className="max-h-[32rem] space-y-1 overflow-y-auto text-sm">
                    {models.map((model) => (
                        <li key={model.name}>
                            <button
                                type="button"
                                onClick={() => setSelected(model.name)}
                                className={[
                                    'w-full rounded-lg px-3 py-2 text-left',
                                    selected === model.name
                                        ? 'bg-indigo-600 text-white'
                                        : isDark
                                          ? 'hover:bg-slate-700/50'
                                          : 'hover:bg-slate-100',
                                ].join(' ')}
                            >
                                <div className="flex justify-between gap-2">
                                    <span className="truncate font-medium">
                                        {model.used_by[0]?.display_name ?? model.name}
                                    </span>
                                    <span className={model.base ? '' : 'text-amber-500'}>
                                        {baseSummary(model.base, en)}
                                    </span>
                                </div>
                                <div className="truncate text-xs opacity-70">
                                    {model.name} · {[...new Set(model.used_by.map((use) => use.tier))].join(' / ')}
                                </div>
                            </button>
                        </li>
                    ))}
                </ul>
            </div>
            <div>
                {current ? (
                    <ModelEditor
                        key={`${current.name}:${current.state}`}
                        model={current}
                        view={view}
                        en={en}
                        isDark={isDark}
                        onSaved={onSaved}
                        onError={onError}
                    />
                ) : (
                    <p className={`py-8 text-center text-sm ${muted}`}>
                        {en ? 'Select a model to edit.' : '选择左侧模型进行编辑。'}
                    </p>
                )}
            </div>
        </div>
    );
}

function Field({
    label,
    value,
    onChange,
    isDark,
    placeholder,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    isDark: boolean;
    placeholder?: string;
}) {
    return (
        <label className="flex flex-col gap-1 text-xs">
            <span>{label}</span>
            <input
                aria-label={label}
                inputMode="decimal"
                className={inputCls(isDark)}
                value={value}
                placeholder={placeholder}
                onChange={(event) => onChange(event.target.value)}
            />
        </label>
    );
}

function ModelEditor({ model, view, en, isDark, onSaved, onError }: PanelProps & { model: SimpleUpstreamModel }) {
    const modality = model.used_by[0]?.modality ?? 'chat';
    const [draft, setDraft] = useState<ModelDraft>(() => draftFrom(model.base, modality));
    const [preview, setPreview] = useState<{ base: BasePrice; data: SimplePreview } | null>(null);
    const [busy, setBusy] = useState(false);
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const set = (patch: Partial<ModelDraft>) => {
        setPreview(null);
        setDraft((previous) => ({ ...previous, ...patch }));
    };
    const setTier = (index: number, patch: Partial<TierDraft>) =>
        set({ tiers: draft.tiers.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)) });
    const switchMode = (mode: BasePrice['mode']) => {
        if (mode === 'tiered' && draft.tiers.length === 0)
            return set({
                mode,
                tiers: [
                    {
                        max: '',
                        inclusive: false,
                        input: draft.input,
                        output: draft.output,
                        cache_read: draft.cache_read,
                        cache_write: draft.cache_write,
                        cache_write_1h: '',
                    },
                ],
            });
        set({ mode });
    };
    const applyReference = (selection: PricingReferenceSelection) => {
        if (draft.mode === 'tiered')
            return set({
                tiers: draft.tiers.map((tier, index) =>
                    index === 0
                        ? {
                              ...tier,
                              input: text(selection.input),
                              output: text(selection.output),
                              cache_read: text(selection.cache_read),
                              cache_write: text(selection.cache_write),
                              cache_write_1h: text(selection.cache_write_1h ?? null),
                          }
                        : tier,
                ),
            });
        set({
            mode: 'token',
            input: text(selection.input),
            output: text(selection.output),
            cache_read: text(selection.cache_read),
            cache_write: text(selection.cache_write),
        });
    };
    const requestPreview = async () => {
        const base = baseFrom(draft);
        setBusy(true);
        onError('');
        try {
            const { preview: data } = await api<{ preview: SimplePreview }>({
                action: 'preview_model',
                model: model.name,
                base,
            });
            setPreview({ base, data });
        } catch (caught) {
            onError(caught instanceof Error ? caught.message : '预览失败。');
        } finally {
            setBusy(false);
        }
    };
    const confirm = async () => {
        if (!preview) return;
        setBusy(true);
        onError('');
        try {
            const { result } = await api<{ result: SaveResult }>({
                action: 'save_model',
                model: model.name,
                base: preview.base,
                expected_state: model.state,
            });
            setPreview(null);
            onSaved(result);
        } catch (caught) {
            onError(caught instanceof Error ? caught.message : '保存失败。');
        } finally {
            setBusy(false);
        }
    };
    const ratios = view.tiers.filter((tier) => model.used_by.some((use) => use.tier === tier.key));
    const modes: Array<[BasePrice['mode'], string, string]> = [
        ['token', '按 Token', 'Per token'],
        ['tiered', '阶梯(按输入长度)', 'Tiered by input length'],
        ['per_call', '按次', 'Per call'],
    ];

    return (
        <div className="space-y-3 text-sm">
            <div>
                <h3 className="text-base font-semibold">{model.name}</h3>
                <p className={`text-xs ${muted}`}>
                    {en ? 'Used by' : '使用它的模型'}:{' '}
                    {model.used_by.map((use) => `${use.display_name}(${use.tier})`).join('、')}
                </p>
                {model.error && <p className="mt-1 text-xs text-red-500">{model.error}</p>}
                {model.notes.map((note) => (
                    <p key={note} className="mt-1 text-xs text-amber-600">
                        ⚠ {note}
                    </p>
                ))}
            </div>
            <div className="flex flex-wrap gap-3">
                {modes.map(([mode, zh, english]) => (
                    <label key={mode} className="flex items-center gap-1 text-xs">
                        <input type="radio" checked={draft.mode === mode} onChange={() => switchMode(mode)} />
                        {en ? english : zh}
                    </label>
                ))}
            </div>
            {draft.mode !== 'per_call' && (
                <PricingReferencePicker
                    modelSlug={model.name}
                    en={en}
                    isDark={isDark}
                    disabled={busy}
                    onApply={applyReference}
                />
            )}
            {draft.mode === 'per_call' && (
                <Field
                    label={en ? 'Price per call ($)' : '每次价格($)'}
                    value={draft.price}
                    onChange={(price) => set({ price })}
                    isDark={isDark}
                />
            )}
            {draft.mode === 'token' && (
                <div className="flex flex-wrap gap-3">
                    <Field
                        label={en ? 'Input $/1M' : '输入 $/百万'}
                        value={draft.input}
                        onChange={(input) => set({ input })}
                        isDark={isDark}
                    />
                    <Field
                        label={en ? 'Output $/1M' : '输出 $/百万'}
                        value={draft.output}
                        onChange={(output) => set({ output })}
                        isDark={isDark}
                    />
                    <Field
                        label={en ? 'Cache read $/1M' : '缓存读 $/百万'}
                        value={draft.cache_read}
                        onChange={(cache_read) => set({ cache_read })}
                        isDark={isDark}
                        placeholder={en ? 'empty = none' : '留空=不单独计'}
                    />
                    <Field
                        label={en ? 'Cache write $/1M' : '缓存写 $/百万'}
                        value={draft.cache_write}
                        onChange={(cache_write) => set({ cache_write })}
                        isDark={isDark}
                        placeholder={en ? 'empty = none' : '留空=不单独计'}
                    />
                </div>
            )}
            {draft.mode === 'token' && model.locked_completion !== null && (
                <p className="text-xs text-amber-600">
                    {en
                        ? `new-api locks output at ${model.locked_completion}× input for this model.`
                        : `new-api 锁定该模型输出价 = 输入价 × ${model.locked_completion};其他比例请用阶梯形态。`}
                </p>
            )}
            {draft.mode === 'tiered' && (
                <div className="space-y-2">
                    {draft.tiers.map((tier, index) => {
                        const last = index === draft.tiers.length - 1;
                        return (
                            <div
                                key={index}
                                className={`rounded-lg border p-2 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}
                            >
                                <div className="mb-2 flex items-center gap-2 text-xs">
                                    <span className="font-medium">
                                        {en ? `Tier ${index + 1}` : `第 ${index + 1} 档`}
                                    </span>
                                    {last ? (
                                        <span className={muted}>{en ? 'all longer inputs' : '更长的全部输入'}</span>
                                    ) : (
                                        <>
                                            <span className={muted}>{en ? 'input length' : '输入长度'}</span>
                                            <select
                                                aria-label="boundary"
                                                className={`rounded border px-1 py-0.5 ${isDark ? 'border-slate-600 bg-slate-900' : 'border-slate-300'}`}
                                                value={tier.inclusive ? 'le' : 'lt'}
                                                onChange={(event) =>
                                                    setTier(index, { inclusive: event.target.value === 'le' })
                                                }
                                            >
                                                <option value="lt">&lt;</option>
                                                <option value="le">≤</option>
                                            </select>
                                            <input
                                                aria-label="max input tokens"
                                                inputMode="numeric"
                                                className={inputCls(isDark)}
                                                value={tier.max}
                                                onChange={(event) => setTier(index, { max: event.target.value })}
                                            />
                                            <span className={muted}>tokens</span>
                                        </>
                                    )}
                                    {draft.tiers.length > 1 && (
                                        <button
                                            type="button"
                                            className="ml-auto text-red-500"
                                            onClick={() => set({ tiers: draft.tiers.filter((_, i) => i !== index) })}
                                        >
                                            {en ? 'Remove' : '删除'}
                                        </button>
                                    )}
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Field
                                        label={en ? 'Input' : '输入'}
                                        value={tier.input}
                                        onChange={(input) => setTier(index, { input })}
                                        isDark={isDark}
                                    />
                                    <Field
                                        label={en ? 'Output' : '输出'}
                                        value={tier.output}
                                        onChange={(output) => setTier(index, { output })}
                                        isDark={isDark}
                                    />
                                    <Field
                                        label={en ? 'Cache read' : '缓存读'}
                                        value={tier.cache_read}
                                        onChange={(cache_read) => setTier(index, { cache_read })}
                                        isDark={isDark}
                                    />
                                    <Field
                                        label={en ? 'Cache write 5m' : '缓存写 5m'}
                                        value={tier.cache_write}
                                        onChange={(cache_write) => setTier(index, { cache_write })}
                                        isDark={isDark}
                                    />
                                    <Field
                                        label={en ? 'Cache write 1h' : '缓存写 1h'}
                                        value={tier.cache_write_1h}
                                        onChange={(cache_write_1h) => setTier(index, { cache_write_1h })}
                                        isDark={isDark}
                                    />
                                </div>
                            </div>
                        );
                    })}
                    <p className={`text-xs ${muted}`}>
                        {en
                            ? 'All prices in $/1M. The full input length picks one tier for the whole request. Cache fields must be filled in every tier or none.'
                            : '单位 $/百万。按完整输入长度选一档，整次请求用该档价格。缓存价须每档都填或都不填。'}
                    </p>
                    <button
                        type="button"
                        className={buttonCls('plain', isDark)}
                        disabled={draft.tiers.length >= 8}
                        onClick={() => {
                            const last = draft.tiers[draft.tiers.length - 1];
                            set({ tiers: [...draft.tiers, { ...last, max: '' }] });
                        }}
                    >
                        {en ? 'Add tier' : '添加一档'}
                    </button>
                </div>
            )}
            {ratios.length > 0 && (
                <p className={`text-xs ${muted}`}>
                    {en ? 'Tier ratios' : '所在档次倍率'}:{' '}
                    {ratios.map((tier) => `${tier.key} ×${tier.ratio ?? '?'}`).join('、')}
                </p>
            )}
            <button
                type="button"
                className={buttonCls('plain', isDark)}
                disabled={busy}
                onClick={() => void requestPreview()}
            >
                {en ? 'Preview' : '预览'}
            </button>
            {preview && (
                <PreviewBox
                    preview={preview.data}
                    en={en}
                    isDark={isDark}
                    busy={busy}
                    onConfirm={() => void confirm()}
                    onCancel={() => setPreview(null)}
                />
            )}
        </div>
    );
}

// ── Overview ──

function OverviewPanel({ view, en, isDark, onSaved, onError }: PanelProps) {
    const [onlyIssues, setOnlyIssues] = useState(false);
    const [busy, setBusy] = useState(false);
    const [runtime, setRuntime] = useState<{ models: RuntimeCheck[]; groups: RuntimeCheck[] } | null>(null);
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const rows = view.models.filter((model) => !onlyIssues || model.cells.some((cell) => cell.status !== 'ok'));
    const stale = view.models.some((model) =>
        model.cells.some((cell) => cell.status === 'mismatch' || cell.status === 'missing'),
    );

    const resync = async () => {
        setBusy(true);
        onError('');
        try {
            const { result } = await api<{ result: SaveResult }>({ action: 'resync_catalog' });
            onSaved(result);
        } catch (caught) {
            onError(caught instanceof Error ? caught.message : '同步失败。');
        } finally {
            setBusy(false);
        }
    };
    const checkRuntime = async () => {
        const names = view.upstream_models.filter((model) => model.base).map((model) => model.name);
        setBusy(true);
        onError('');
        try {
            const results: { models: RuntimeCheck[]; groups: RuntimeCheck[] } = { models: [], groups: [] };
            for (let i = 0; i < names.length; i += 30) {
                const { check } = await api<{ check: typeof results }>({
                    action: 'verify_runtime',
                    models: names.slice(i, i + 30),
                });
                results.models.push(...check.models);
                if (!results.groups.length) results.groups = check.groups;
            }
            setRuntime(results);
        } catch (caught) {
            onError(caught instanceof Error ? caught.message : '核对失败。');
        } finally {
            setBusy(false);
        }
    };
    const statusCls = (status: CellStatus) =>
        status === 'ok'
            ? 'text-emerald-600'
            : status === 'mismatch' || status === 'missing'
              ? 'text-amber-600'
              : 'text-red-500';
    const runtimeIssues = runtime ? [...runtime.groups, ...runtime.models].filter((row) => !row.ok) : [];

    return (
        <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1 text-xs">
                    <input
                        type="checkbox"
                        checked={onlyIssues}
                        onChange={(event) => setOnlyIssues(event.target.checked)}
                    />
                    {en ? 'Only issues' : '只看有问题的'}
                </label>
                <button
                    type="button"
                    className={buttonCls('plain', isDark)}
                    disabled={busy || !stale}
                    onClick={() => void resync()}
                >
                    {en ? 'Sync catalog from new-api' : '按 new-api 同步目录价'}
                </button>
                <button
                    type="button"
                    className={buttonCls('plain', isDark)}
                    disabled={busy}
                    onClick={() => void checkRuntime()}
                >
                    {en ? 'Check new-api runtime' : '核对 new-api 运行时'}
                </button>
            </div>
            <p className={`text-xs ${muted}`}>
                {en
                    ? 'Each cell shows what new-api bills (input / output ¥ per 1M, or ¥ per call). "Catalog stale" means the price shown to customers differs.'
                    : '每格为 new-api 实际扣费(输入/输出 ¥每百万，或 ¥每次)。「目录待同步」下方逐项列出目录与实际扣费的差异，核对后点上方同步即可(只改展示，不改扣费)。'}
            </p>
            {runtime && (
                <div
                    className={`rounded-lg border p-3 text-xs ${runtimeIssues.length ? 'border-amber-300' : 'border-emerald-300'}`}
                >
                    {runtimeIssues.length === 0
                        ? en
                            ? 'new-api runtime matches its configuration.'
                            : 'new-api 运行时与配置一致。'
                        : runtimeIssues.map((row) => (
                              <p key={row.name}>
                                  {row.name}:{row.diffs.join(' ')}
                              </p>
                          ))}
                    {runtimeIssues.length > 0 && (
                        <p className={`mt-1 ${muted}`}>
                            {en
                                ? 'new-api may cache pricing for about a minute; recheck shortly.'
                                : 'new-api 价格页约有 1 分钟缓存，刚保存的请稍后再核对。'}
                        </p>
                    )}
                </div>
            )}
            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead className={muted}>
                        <tr>
                            <th className="py-2 text-left">{en ? 'Model' : '模型'}</th>
                            {view.tiers.map((tier) => (
                                <th key={tier.id} className="py-2 text-right">
                                    {tier.display_name}
                                    <div className="font-normal">×{tier.ratio ?? '?'}</div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((model) => (
                            <tr
                                key={model.id}
                                className={isDark ? 'border-t border-slate-700' : 'border-t border-slate-100'}
                            >
                                <td className="py-2">
                                    <div className="font-medium">{model.display_name}</div>
                                    <div className={muted}>{model.slug}</div>
                                </td>
                                {view.tiers.map((tier) => {
                                    const cell = model.cells.find((row) => row.tier === tier.key);
                                    if (!cell)
                                        return (
                                            <td key={tier.id} className={`py-2 text-right ${muted}`}>
                                                —
                                            </td>
                                        );
                                    return (
                                        <td key={tier.id} className="py-2 text-right align-top">
                                            <div>{amountsLabel(cell.expected, en)}</div>
                                            <div className={statusCls(cell.status)}>
                                                {STATUS_LABEL[cell.status][en ? 1 : 0]}
                                            </div>
                                            {cell.status === 'mismatch' &&
                                                cell.diffs.map((diff) => (
                                                    <div
                                                        key={`${diff.tier}-${diff.field}`}
                                                        className={`text-xs ${muted}`}
                                                    >
                                                        {diffLabel(diff, en)}
                                                    </div>
                                                ))}
                                            {cell.expected?.billing_details &&
                                                cell.expected.billing_details.tiers.length > 1 && (
                                                    <div className="text-left">
                                                        <CatalogTieredPriceDetails
                                                            raw={cell.expected.billing_details}
                                                            en={en}
                                                        />
                                                    </div>
                                                )}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ── Bill check ──

const LINE_LABEL: Record<BillLine['key'], [string, string]> = {
    input: ['输入', 'Input'],
    output: ['输出', 'Output'],
    cache_read: ['缓存读', 'Cache read'],
    cache_write: ['缓存写', 'Cache write'],
    cache_write_1h: ['缓存写 1h', 'Cache write 1h'],
    per_call: ['按次', 'Per call'],
};

interface UsageDraft {
    prompt: string;
    completion: string;
    cache_read: string;
    cache_write: string;
    cache_write_1h: string;
}

const EMPTY_USAGE: UsageDraft = { prompt: '', completion: '', cache_read: '', cache_write: '', cache_write_1h: '' };

function count(raw: string): number {
    const value = Number(raw.trim() || 0);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function Verdict({ ok, en }: { ok: boolean; en: boolean }) {
    return ok ? (
        <span className="font-medium text-emerald-600">✓ {en ? 'matches' : '对得上'}</span>
    ) : (
        <span className="font-medium text-red-500">✗ {en ? 'does not match' : '对不上'}</span>
    );
}

function BillCheckPanel({ view, en, isDark, onError }: PanelProps) {
    const [tierKey, setTierKey] = useState(view.tiers[0]?.key ?? '');
    const [modelName, setModelName] = useState('');
    const [usage, setUsage] = useState<UsageDraft>(EMPTY_USAGE);
    const [anthropic, setAnthropic] = useState(false);
    const [customerActual, setCustomerActual] = useState('');
    const [upstreamActual, setUpstreamActual] = useState('');
    const [requestId, setRequestId] = useState('');
    const [lookup, setLookup] = useState<LoggedBillLookup | null>(null);
    const [busy, setBusy] = useState(false);
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const units = view.units;

    const tier = view.tiers.find((row) => row.key === tierKey) ?? null;
    const models = view.upstream_models.filter((model) => model.used_by.some((use) => use.tier === tierKey));
    const model = view.upstream_models.find((row) => row.name === modelName) ?? null;
    const setField = (key: keyof UsageDraft, value: string) => setUsage((previous) => ({ ...previous, [key]: value }));
    const logCny = (quota: number) => (quota / units.quota_per_usd) * units.base_fx;

    const loadLog = async () => {
        setBusy(true);
        onError('');
        try {
            const { lookup: found } = await api<{ lookup: LoggedBillLookup }>({
                action: 'lookup_log',
                request_id: requestId.trim(),
            });
            const { log } = found;
            setLookup(found);
            if (found.tier) setTierKey(found.tier);
            const match =
                view.upstream_models.find((row) => row.name === log.model) ??
                view.upstream_models.find((row) => row.used_by.some((use) => use.slug === log.model));
            setModelName(match?.name ?? '');
            setUsage({
                prompt: String(log.usage.prompt),
                completion: String(log.usage.completion),
                cache_read: String(log.usage.cache_read),
                cache_write: String(log.usage.cache_write),
                cache_write_1h: String(log.usage.cache_write_1h),
            });
            setAnthropic(log.usage.anthropic);
            setCustomerActual(pricingNumberInput(Number(logCny(log.quota).toFixed(6))));
        } catch (caught) {
            setLookup(null);
            onError(caught instanceof Error ? caught.message : '查询失败。');
        } finally {
            setBusy(false);
        }
    };

    const estimate =
        model?.base && tier?.ratio
            ? estimateBill(
                  model.base,
                  {
                      prompt: count(usage.prompt),
                      completion: count(usage.completion),
                      cache_read: count(usage.cache_read),
                      cache_write: count(usage.cache_write),
                      cache_write_1h: count(usage.cache_write_1h),
                      anthropic,
                  },
                  tier.ratio,
                  tier.purchase_rate,
                  { base_fx: units.base_fx, quota_per_usd: units.quota_per_usd },
              )
            : null;
    const customerTyped = pricingNumberFromInput(customerActual);
    const upstreamTyped = pricingNumberFromInput(upstreamActual);
    // A value loaded from the log is compared quota-exact; a hand-typed ¥ within 0.5%.
    const fromLog =
        lookup !== null && customerActual === pricingNumberInput(Number(logCny(lookup.log.quota).toFixed(6)));
    const customerOk =
        estimate && customerTyped !== null
            ? fromLog
                ? quotaMatches(estimate.quota, lookup!.log.quota)
                : cnyMatches(estimate.customer_cny, customerTyped, 0.005)
            : null;
    const upstreamOk =
        estimate?.upstream_cny != null && upstreamTyped !== null
            ? cnyMatches(estimate.upstream_cny, upstreamTyped)
            : null;
    const recorded = lookup?.log.recorded ?? null;
    const recordedRatio = recorded ? (recorded.user_group_ratio ?? recorded.group_ratio) : null;
    const hints: string[] = [];
    if (lookup && customerOk === false && tier?.ratio && recordedRatio !== null && recordedRatio !== tier.ratio)
        hints.push(
            recorded?.user_group_ratio
                ? en
                    ? `This customer has a custom ratio ${recorded.user_group_ratio}; the tier sell rate is ${tier.ratio}.`
                    : `这位客户有专属倍率 ${recorded.user_group_ratio}(档次售价率 ${tier.ratio}),按专属倍率应扣 ¥${Number(((estimate!.customer_cny * recordedRatio) / tier.ratio).toFixed(6))}。`
                : en
                  ? `new-api billed with ratio ${recordedRatio} at the time; the sell rate is now ${tier.ratio}.`
                  : `这条日志当时按倍率 ${recordedRatio} 扣费，当前售价率是 ${tier.ratio}(可能是之后改过价)。`,
        );
    if (lookup && customerOk === false && recorded && model?.base?.mode === 'token' && recorded.model_ratio !== null)
        if (Math.abs(recorded.model_ratio * units.ratio_unit - model.base.input) > 1e-9)
            hints.push(
                en
                    ? `The log recorded input $${recorded.model_ratio * units.ratio_unit}/1M; the base price is now $${model.base.input}.`
                    : `日志记录的输入价是 $${Number((recorded.model_ratio * units.ratio_unit).toFixed(6))}/百万，当前基础价 $${model.base.input}(之后改过价?)。`,
            );
    if (lookup && !lookup.tier)
        hints.push(
            en
                ? `new-api group "${lookup.log.group}" is not an enabled tier; pick the tier by hand.`
                : `日志的 new-api 分组「${lookup.log.group}」不是启用中的档次，请手动选择档次。`,
        );
    if (lookup && !modelName)
        hints.push(
            en
                ? `Model "${lookup.log.model}" is not in the catalog; pick it by hand.`
                : `日志模型「${lookup.log.model}」不在目录映射里，请手动选择模型。`,
        );

    const selectCls = `rounded border px-2 py-1 text-sm ${isDark ? 'border-slate-600 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white'}`;
    const perCall = model?.base?.mode === 'per_call';

    return (
        <div className="space-y-4 text-sm">
            <p className={`text-xs ${muted}`}>
                {en
                    ? 'Recompute one request the way new-api bills it, then compare with what was actually charged (customer) and what the upstream charged us.'
                    : '按 new-api 的扣费规则重算一次请求：客户侧 = 基础价 × 售价率，对比 new-api 实扣；上游侧 = 基础价 × 进货率，对比上游后台实扣。'}
            </p>
            <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-xs">
                    <span>{en ? 'Load from a new-api log (optional)' : '从 new-api 日志带出(可选)'}</span>
                    <input
                        aria-label="request_id"
                        className={`w-72 ${inputCls(isDark)}`}
                        placeholder="request_id"
                        value={requestId}
                        onChange={(event) => setRequestId(event.target.value)}
                    />
                </label>
                <button
                    type="button"
                    className={buttonCls('plain', isDark)}
                    disabled={busy || !requestId.trim()}
                    onClick={() => void loadLog()}
                >
                    {busy ? (en ? 'Loading…' : '查询中…') : en ? 'Load' : '带出'}
                </button>
                {lookup && (
                    <span className={`text-xs ${muted}`}>
                        {new Date(lookup.log.created_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}{' '}
                        · {lookup.log.model} · {lookup.log.group} · {en ? 'channel' : '渠道'} {lookup.log.channel}
                    </span>
                )}
            </div>
            <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-xs">
                    <span>{en ? 'Tier' : '档次'}</span>
                    <select
                        aria-label="tier"
                        className={selectCls}
                        value={tierKey}
                        onChange={(event) => {
                            setTierKey(event.target.value);
                            setModelName('');
                        }}
                    >
                        {view.tiers.map((row) => (
                            <option key={row.id} value={row.key}>
                                {row.display_name}({en ? 'sell' : '售'} {row.ratio ?? '?'} / {en ? 'buy' : '进'}{' '}
                                {row.purchase_rate ?? '?'})
                            </option>
                        ))}
                    </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                    <span>{en ? 'Model' : '模型'}</span>
                    <select
                        aria-label="model"
                        className={selectCls}
                        value={modelName}
                        onChange={(event) => setModelName(event.target.value)}
                    >
                        <option value="">{en ? 'Select…' : '请选择…'}</option>
                        {(models.some((row) => row.name === modelName) || !model ? models : [model, ...models]).map(
                            (row) => (
                                <option key={row.name} value={row.name}>
                                    {row.used_by[0]?.display_name ?? row.name}({row.name})
                                </option>
                            ),
                        )}
                    </select>
                </label>
                {model && (
                    <span className={`pb-1 text-xs ${muted}`}>
                        {en ? 'Base price' : '基础价'} {baseSummary(model.base, en)}
                    </span>
                )}
            </div>
            {!perCall && (
                <div className="flex flex-wrap items-end gap-3">
                    <Field
                        label={en ? 'Input tokens' : '输入 tokens'}
                        value={usage.prompt}
                        onChange={(value) => setField('prompt', value)}
                        isDark={isDark}
                    />
                    <Field
                        label={en ? 'Output tokens' : '输出 tokens'}
                        value={usage.completion}
                        onChange={(value) => setField('completion', value)}
                        isDark={isDark}
                    />
                    <Field
                        label={en ? 'Cache read' : '缓存读'}
                        value={usage.cache_read}
                        onChange={(value) => setField('cache_read', value)}
                        isDark={isDark}
                    />
                    <Field
                        label={en ? 'Cache write' : '缓存写'}
                        value={usage.cache_write}
                        onChange={(value) => setField('cache_write', value)}
                        isDark={isDark}
                    />
                    <Field
                        label={en ? 'Cache write 1h' : '缓存写 1h'}
                        value={usage.cache_write_1h}
                        onChange={(value) => setField('cache_write_1h', value)}
                        isDark={isDark}
                    />
                    <label className="flex items-center gap-1 pb-1 text-xs">
                        <input
                            type="checkbox"
                            checked={anthropic}
                            onChange={(event) => setAnthropic(event.target.checked)}
                        />
                        {en ? 'Claude format' : 'Claude 格式'}
                    </label>
                </div>
            )}
            {!perCall && (
                <p className={`text-xs ${muted}`}>
                    {en
                        ? 'Claude format: input excludes cache tokens. OpenAI format: input includes them and new-api subtracts them. Loading a log sets this for you.'
                        : 'Claude 格式：输入 tokens 不含缓存；OpenAI 格式：输入 tokens 含缓存，new-api 会先扣掉缓存部分再计价。从日志带出时自动判断。'}
                </p>
            )}
            <div className="flex flex-wrap items-end gap-3">
                <Field
                    label={en ? 'Customer charged ¥ (new-api)' : '客户实扣 ¥(new-api)'}
                    value={customerActual}
                    onChange={setCustomerActual}
                    isDark={isDark}
                />
                <Field
                    label={en ? 'Upstream charged ¥' : '上游实扣 ¥'}
                    value={upstreamActual}
                    onChange={setUpstreamActual}
                    isDark={isDark}
                />
            </div>
            {!model ? null : !model.base ? (
                <p className="text-amber-600">
                    {en ? 'This model is unpriced in new-api.' : '该模型在 new-api 未定价。'}
                </p>
            ) : !tier?.ratio ? (
                <p className="text-amber-600">{en ? 'This tier has no sell rate.' : '该档次没有售价率。'}</p>
            ) : (
                estimate && (
                    <div
                        className={`space-y-3 rounded-lg border p-3 ${isDark ? 'border-slate-600' : 'border-slate-200'}`}
                    >
                        <table className="w-full text-xs">
                            <thead className={muted}>
                                <tr>
                                    <th className="py-1 text-left">{en ? 'Item' : '项目'}</th>
                                    <th className="py-1 text-right">{perCall ? (en ? 'Calls' : '次数') : 'tokens'}</th>
                                    <th className="py-1 text-right">
                                        {perCall ? (en ? '$ per call' : '$/次') : en ? '$ per 1M' : '$/百万'}
                                    </th>
                                    <th className="py-1 text-right">{en ? 'Official $' : '官方价 $'}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {estimate.lines.map((row) => (
                                    <tr key={row.key}>
                                        <td className="py-1">{LINE_LABEL[row.key][en ? 1 : 0]}</td>
                                        <td className="py-1 text-right">{row.tokens.toLocaleString('en-US')}</td>
                                        <td className="py-1 text-right">{Number(row.price.toFixed(6))}</td>
                                        <td className="py-1 text-right">{Number(row.usd.toFixed(8))}</td>
                                    </tr>
                                ))}
                                <tr className="font-medium">
                                    <td className="py-1">
                                        {en ? 'Total' : '合计'}
                                        {estimate.tier !== null &&
                                            (en ? ` (tier ${estimate.tier + 1})` : `(第 ${estimate.tier + 1} 档)`)}
                                    </td>
                                    <td />
                                    <td />
                                    <td className="py-1 text-right">${Number(estimate.official_usd.toFixed(8))}</td>
                                </tr>
                            </tbody>
                        </table>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div>
                                <p className="font-medium">
                                    {en ? 'Customer' : '客户侧'}
                                    <span className={`ml-1 text-xs font-normal ${muted}`}>
                                        × {en ? 'sell rate' : '售价率'} {tier.ratio}
                                    </span>
                                </p>
                                <p>
                                    {en ? 'Should charge' : '应扣'} ¥{Number(estimate.customer_cny.toFixed(6))}
                                    <span className={`ml-1 text-xs ${muted}`}>
                                        ({estimate.quota.toLocaleString('en-US')} quota)
                                    </span>
                                </p>
                                {customerOk !== null && (
                                    <p>
                                        {en ? 'Charged' : '实扣'} ¥{customerTyped}
                                        {fromLog && (
                                            <span className={`ml-1 text-xs ${muted}`}>
                                                ({lookup!.log.quota.toLocaleString('en-US')} quota)
                                            </span>
                                        )}{' '}
                                        <Verdict ok={customerOk} en={en} />
                                    </p>
                                )}
                            </div>
                            <div>
                                <p className="font-medium">
                                    {en ? 'Upstream' : '上游侧'}
                                    <span className={`ml-1 text-xs font-normal ${muted}`}>
                                        × {en ? 'buy rate' : '进货率'} {tier.purchase_rate ?? '?'}
                                    </span>
                                </p>
                                {estimate.upstream_cny === null ? (
                                    <p className="text-amber-600">
                                        {en
                                            ? 'Set the buy rate on the tiers tab first.'
                                            : '先在「档次与利润」里填这个档次的进货率。'}
                                    </p>
                                ) : (
                                    <>
                                        <p>
                                            {en ? 'Should cost' : '应付'} ¥{Number(estimate.upstream_cny.toFixed(6))}
                                            <span className={`ml-1 text-xs ${muted}`}>
                                                {en ? 'profit' : '毛利'} ¥
                                                {Number((estimate.customer_cny - estimate.upstream_cny).toFixed(6))}
                                            </span>
                                        </p>
                                        {upstreamOk !== null && (
                                            <p>
                                                {en ? 'Charged' : '实扣'} ¥{upstreamTyped}{' '}
                                                <Verdict ok={upstreamOk} en={en} />
                                                {!upstreamOk && (
                                                    <span className={`ml-1 text-xs ${muted}`}>
                                                        {en ? 'implied buy rate' : '反推进货率'}{' '}
                                                        {estimate.official_usd > 0
                                                            ? Number(
                                                                  (
                                                                      upstreamTyped! /
                                                                      (estimate.official_usd * units.base_fx)
                                                                  ).toFixed(4),
                                                              )
                                                            : '—'}
                                                    </span>
                                                )}
                                            </p>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                        {hints.map((hint) => (
                            <p key={hint} className="text-xs text-amber-600">
                                ⚠ {hint}
                            </p>
                        ))}
                    </div>
                )
            )}
            {hints.length > 0 && !estimate && (
                <div className="space-y-1">
                    {hints.map((hint) => (
                        <p key={hint} className="text-xs text-amber-600">
                            ⚠ {hint}
                        </p>
                    ))}
                </div>
            )}
        </div>
    );
}

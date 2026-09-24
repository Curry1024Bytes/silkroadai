'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import PricingReferencePicker, { type PricingReferenceSelection } from '@/components/admin/PricingReferencePicker';
import CatalogTieredPriceDetails from '@/components/admin/CatalogTieredPriceDetails';
import { pricingNumberFromInput, pricingNumberInput } from '@/components/admin/pricing-number-input';
import type { BasePrice } from '@/lib/admin/pricing-simple-core';
import type {
    CellStatus,
    RuntimeCheck,
    SaveResult,
    SimplePreview,
    SimplePricingView,
    SimpleUpstreamModel,
} from '@/lib/admin/pricing-simple';
import type { CatalogAmounts } from '@/lib/admin/pricing-simple-core';

type Tab = 'tiers' | 'models' | 'overview';

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
        ['tiers', '档次倍率', 'Tier ratios'],
        ['models', '模型基础价', 'Model base prices'],
        ['overview', '价格总览', 'Price overview'],
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
                    ? 'Customer price = model base price (official $) × tier ratio. Saving writes new-api immediately and verifies it.'
                    : '客户价 = 模型基础价(官方 $)× 档次倍率。保存即写入 new-api 并回读核对，立刻生效。'}
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
                    <TiersPanel view={view} en={en} isDark={isDark} onSaved={saved} onError={setError} />
                ) : tab === 'models' ? (
                    <ModelsPanel view={view} en={en} isDark={isDark} onSaved={saved} onError={setError} />
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

function TiersPanel({ view, en, isDark, onSaved, onError }: PanelProps) {
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [preview, setPreview] = useState<{ id: string; ratio: number; data: SimplePreview } | null>(null);
    const [busy, setBusy] = useState(false);
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';

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
                    ? 'The ratio is how many ¥ this tier charges per official $1. It applies to every model in the tier.'
                    : '倍率 = 该档每 1 美元官方价收多少元。对该档所有模型统一生效；客户专属倍率不受影响。'}
            </p>
            <table className="w-full text-sm">
                <thead className={muted}>
                    <tr>
                        <th className="py-2 text-left">{en ? 'Tier' : '档次'}</th>
                        <th className="py-2 text-left">{en ? 'new-api group' : 'new-api 分组'}</th>
                        <th className="py-2 text-right">{en ? 'Models' : '模型数'}</th>
                        <th className="py-2 text-right">{en ? 'Active keys' : '在用 Key'}</th>
                        <th className="py-2 text-right">{en ? 'Custom ratios' : '专属倍率客户'}</th>
                        <th className="py-2 text-right">{en ? 'Ratio (¥ per $1)' : '倍率(¥/$1)'}</th>
                        <th className="py-2 text-right">{en ? 'New ratio' : '新倍率'}</th>
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
                                <div className={`text-xs ${muted}`}>{tier.key}</div>
                            </td>
                            <td className="py-2">{tier.newapi_group}</td>
                            <td className="py-2 text-right">{tier.model_count}</td>
                            <td className="py-2 text-right">{tier.active_keys}</td>
                            <td className="py-2 text-right">{tier.customer_overrides}</td>
                            <td className="py-2 text-right font-medium">
                                {tier.ratio ?? <span className="text-red-500">{en ? 'missing' : '缺失'}</span>}
                            </td>
                            <td className="py-2 text-right">
                                <div className="flex justify-end gap-2">
                                    <input
                                        aria-label={`${tier.key} ratio`}
                                        inputMode="decimal"
                                        className={inputCls(isDark)}
                                        value={drafts[tier.id] ?? ''}
                                        placeholder={tier.ratio === null ? '' : String(tier.ratio)}
                                        onChange={(event) => setDrafts({ ...drafts, [tier.id]: event.target.value })}
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
                    : '每格为 new-api 实际扣费(输入/输出 ¥每百万，或 ¥每次)。「目录待同步」= 客户看到的价格与实际扣费不一致，点上方同步即可。'}
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
                                            {cell.status === 'mismatch' && (
                                                <div className={muted}>
                                                    {en ? 'catalog' : '目录'} {amountsLabel(cell.catalog, en)}
                                                </div>
                                            )}
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

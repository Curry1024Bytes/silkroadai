'use client';

import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';

const referencePriceSchema = z.object({
    model: z.string().min(1),
    inputUsdPer1m: z.number().finite().positive(),
    outputUsdPer1m: z.number().finite().positive(),
    cacheReadUsdPer1m: z.number().finite().nonnegative().nullable(),
    cacheWrite5mUsdPer1m: z.number().finite().nonnegative().nullable(),
});
const referenceResponseSchema = z.object({
    source_label: z.string().min(1),
    fetched_at: z.string().datetime(),
    models: z.array(referencePriceSchema),
});

type ReferenceResponse = z.infer<typeof referenceResponseSchema>;

export interface PricingReferenceSelection {
    model: string;
    input: number;
    output: number;
    cache_read: number | null;
    /** Five-minute cache creation only; an hourly price must not silently replace it. */
    cache_write: number | null;
    sourceLabel: string;
    fetchedAt: string;
}

export interface PricingReferencePickerProps {
    modelSlug: string;
    en: boolean;
    isDark: boolean;
    disabled?: boolean;
    onApply: (selection: PricingReferenceSelection) => void;
}

/** Cancelled or superseded lookups never deliver prices to a changed draft. */
export function createPricingReferenceLookup(fetcher: typeof fetch = fetch) {
    let generation = 0;
    let controller: AbortController | null = null;
    function cancel() {
        generation += 1;
        controller?.abort();
        controller = null;
    }
    return {
        cancel,
        async search(query: string, onResult: (result: ReferenceResponse) => void, onError: () => void): Promise<void> {
            cancel();
            const requestGeneration = generation;
            controller = new AbortController();
            try {
                const response = await fetcher(
                    `/api/admin/pricing-calculator/official-prices?q=${encodeURIComponent(query.trim())}`,
                    { cache: 'no-store', signal: controller.signal },
                );
                if (!response.ok) throw new Error('reference_lookup_failed');
                const result = referenceResponseSchema.parse(await response.json());
                if (generation === requestGeneration) onResult(result);
            } catch {
                if (generation === requestGeneration) onError();
            }
        },
    };
}

function referenceSelection(result: ReferenceResponse, model: string): PricingReferenceSelection | null {
    const selected = result.models.find((price) => price.model === model);
    if (!selected) return null;
    return {
        model: selected.model,
        input: selected.inputUsdPer1m,
        output: selected.outputUsdPer1m,
        cache_read: selected.cacheReadUsdPer1m,
        cache_write: selected.cacheWrite5mUsdPer1m,
        sourceLabel: result.source_label,
        fetchedAt: result.fetched_at,
    };
}

export function PricingReferenceResult({
    result,
    selectedModel,
    confirmed,
    disabled,
    en,
    inputClass,
    onSelect,
    onConfirm,
    onApply,
}: {
    result: ReferenceResponse;
    selectedModel: string;
    confirmed: boolean;
    disabled: boolean;
    en: boolean;
    inputClass: string;
    onSelect: (model: string) => void;
    onConfirm: (checked: boolean) => void;
    onApply: (selection: PricingReferenceSelection) => void;
}) {
    const selection = referenceSelection(result, selectedModel);
    const amount = (value: number | null) =>
        value === null
            ? en
                ? 'Not provided'
                : '未提供'
            : `$${value.toLocaleString('en-US', { maximumFractionDigits: 10 })}`;
    if (result.models.length === 0) {
        return (
            <p role="status">
                {en
                    ? 'No matching reference price. Enter the supplier quote manually.'
                    : '未找到匹配参考价，请手动填写上游报价。'}
            </p>
        );
    }
    return (
        <div className="space-y-3">
            <label className="block space-y-1.5 text-sm">
                <span>{en ? 'Reference model' : '参考模型'}</span>
                <select
                    className={inputClass}
                    value={selectedModel}
                    disabled={disabled}
                    onChange={(event) => onSelect(event.target.value)}
                >
                    {result.models.map((price) => (
                        <option key={price.model} value={price.model}>
                            {price.model} · ${price.inputUsdPer1m} / ${price.outputUsdPer1m}
                        </option>
                    ))}
                </select>
            </label>
            <p className="text-xs opacity-75">
                {en ? 'Reference source' : '参考价来源'}：{result.source_label} ·{' '}
                {new Date(result.fetched_at).toLocaleString(en ? 'en-GB' : 'zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    hour12: false,
                })}{' '}
                {en ? '(Beijing)' : '（北京时间）'}
            </p>
            {selection && (
                <>
                    <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                        {[
                            [en ? 'Input' : '输入', selection.input],
                            [en ? 'Output' : '输出', selection.output],
                            [en ? 'Cache read' : '缓存读取', selection.cache_read],
                            [en ? 'Cache write · 5 min' : '缓存写入 · 5 分钟', selection.cache_write],
                        ].map(([label, value]) => (
                            <div key={String(label)}>
                                <dt className="opacity-75">{label}</dt>
                                <dd className="mt-1 font-medium">{amount(value as number | null)} / 1M</dd>
                            </div>
                        ))}
                    </dl>
                    <label className="flex cursor-pointer items-start gap-2 text-sm leading-relaxed">
                        <input
                            type="checkbox"
                            checked={confirmed}
                            disabled={disabled}
                            className="mt-1 h-4 w-4 shrink-0 accent-emerald-600"
                            onChange={(event) => onConfirm(event.target.checked)}
                        />
                        <span>
                            {en
                                ? 'My supplier bills credits using these base numbers ($1 reference price = 1 credit, multiplier applied separately).'
                                : '上游按这组基准数字扣额度（$1 参考价对应 1 额度，倍率另算）。'}
                        </span>
                    </label>
                    <p className="text-xs leading-relaxed opacity-75">
                        {en
                            ? 'Applying replaces the current base prices and selects upstream credits. Missing cache prices become blank. Recharge ratio and multipliers remain yours to enter; nothing is saved or published.'
                            : '填入将覆盖当前基础价，单位改为上游账户额度；缺失缓存价会留空。充值比例和倍率仍按实际填写，不会自动保存或发布。'}
                    </p>
                    <button
                        type="button"
                        disabled={disabled || !confirmed}
                        className="min-h-11 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => {
                            if (confirmed && !disabled) onApply(selection);
                        }}
                    >
                        {en ? 'Confirm replacing base prices' : '确认替换当前基础价'}
                    </button>
                </>
            )}
        </div>
    );
}

function PricingReferencePickerSession({
    modelSlug,
    en,
    isDark,
    disabled = false,
    onApply,
}: PricingReferencePickerProps) {
    const [query, setQuery] = useState(modelSlug);
    const [result, setResult] = useState<ReferenceResponse | null>(null);
    const [selectedModel, setSelectedModel] = useState('');
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);
    const lookup = useMemo(() => createPricingReferenceLookup(), []);
    useEffect(() => () => lookup.cancel(), [lookup]);
    const inputClass = `min-h-11 w-full min-w-0 rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-60 ${isDark ? 'border-slate-600 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white text-slate-900'}`;
    return (
        <section
            className={`space-y-3 rounded-lg border p-4 ${isDark ? 'border-slate-700 bg-slate-900/30' : 'border-slate-200 bg-slate-50'}`}
        >
            <h3 className="text-sm font-semibold">{en ? 'Look up base reference prices' : '查询基础参考价'}</h3>
            <p className="text-xs leading-relaxed opacity-75">
                {en
                    ? 'LiteLLM base reference prices in USD per million tokens. Confirm the supplier uses these base prices before filling them in.'
                    : 'LiteLLM 基础参考价，单位为美元／百万 token。确认上游使用这组基础价格后即可填入。'}
            </p>
            <div className="flex flex-wrap items-end gap-2">
                <label className="block min-w-0 flex-1 space-y-1.5 text-sm">
                    <span>{en ? 'Model name to look up' : '查询模型名'}</span>
                    <input
                        className={inputClass}
                        value={query}
                        maxLength={120}
                        disabled={disabled}
                        onChange={(event) => {
                            lookup.cancel();
                            setQuery(event.target.value);
                            setResult(null);
                            setSelectedModel('');
                            setConfirmed(false);
                            setError(false);
                            setBusy(false);
                        }}
                    />
                </label>
                <button
                    type="button"
                    disabled={disabled || busy || !query.trim()}
                    className={`min-h-11 rounded-lg border px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${isDark ? 'border-slate-600 hover:bg-slate-800' : 'border-slate-300 bg-white hover:bg-slate-100'}`}
                    onClick={() => {
                        if (disabled || busy || !query.trim()) return;
                        setBusy(true);
                        setError(false);
                        setResult(null);
                        setConfirmed(false);
                        void lookup.search(
                            query,
                            (next) => {
                                setResult(next);
                                setSelectedModel(next.models[0]?.model ?? '');
                                setBusy(false);
                            },
                            () => {
                                setError(true);
                                setBusy(false);
                            },
                        );
                    }}
                >
                    {busy ? (en ? 'Looking up…' : '查询中…') : en ? 'Look up' : '查询参考价'}
                </button>
            </div>
            {error && (
                <p role="alert" className={isDark ? 'text-amber-200' : 'text-amber-800'}>
                    {en
                        ? 'Reference prices are unavailable. Retry or enter the supplier quote manually.'
                        : '参考价暂时无法读取，可重试或手动填写上游报价。'}
                </p>
            )}
            {result && (
                <PricingReferenceResult
                    result={result}
                    selectedModel={selectedModel}
                    confirmed={confirmed}
                    disabled={disabled || busy}
                    en={en}
                    inputClass={inputClass}
                    onSelect={(model) => {
                        setSelectedModel(model);
                        setConfirmed(false);
                    }}
                    onConfirm={setConfirmed}
                    onApply={(selection) => {
                        onApply(selection);
                        setConfirmed(false);
                    }}
                />
            )}
        </section>
    );
}

export default function PricingReferencePicker(props: PricingReferencePickerProps) {
    return <PricingReferencePickerSession key={props.modelSlug} {...props} />;
}

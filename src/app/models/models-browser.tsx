'use client';

import { useMemo, useState, useEffect } from 'react';
import { Check, ChevronRight, Copy, Search } from 'lucide-react';
import {
    type ModelEntry,
    type TypeName,
    TYPE_BADGE,
    VENDOR_META,
    VENDOR_ORDER,
    filterEntries,
} from '@/lib/models/categorize';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import type { BrowserModelPricing, BrowserTier } from '@/lib/models/catalog-browser-types';
import type { TierPricing } from '@/lib/models/machine-catalog';
import { formatTieredPrice } from '@/lib/models/tiered-pricing-details';
import { catalogPriceSummary, catalogSummaryTier } from '@/lib/models/catalog-price-summary';
import { CUSTOMER_API_BASE_URL } from '@/lib/public-config';
import { ModelPriceDialog } from './model-prices';

export { ModelTierPrices } from './model-prices';

interface Props {
    entries: ModelEntry[];
    totalModels: number;
    vendorCount: number;
    tiers: BrowserTier[];
    pricing: BrowserModelPricing[];
    embedded?: boolean;
}

const TYPE_FILTERS = [
    { key: 'text', label: '对话与视觉', types: ['chat', 'vision'] },
    { key: 'image', label: '图像生成', types: ['image-gen'] },
    { key: 'video', label: '视频生成', types: ['video'] },
    { key: 'audio', label: '音频', types: ['audio'] },
    { key: 'embedding', label: '向量嵌入', types: ['embedding'] },
] as const;
type ModelTypeFilter = '' | (typeof TYPE_FILTERS)[number]['key'];
const FIELD_CLASS =
    'min-h-11 w-full rounded-lg border border-brand-border bg-surface px-3 py-2.5 text-sm text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-accent';

export function filterCatalogTier(entries: ModelEntry[], pricing: BrowserModelPricing[], tier: string) {
    const members = new Set(
        pricing.filter((model) => !tier || Object.hasOwn(model.pricesByTier, tier)).map((model) => model.slug),
    );
    return entries.filter((entry) => members.has(entry.shortName));
}

export function ModelsBrowser({ entries, tiers, pricing, embedded = false }: Props) {
    const [tier, setTier] = useState('');
    const [vendor, setVendor] = useState('');
    const [type, setType] = useState<ModelTypeFilter>('');
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [detailModel, setDetailModel] = useState<string | null>(null);
    useEffect(() => {
        const id = setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), 200);
        return () => clearTimeout(id);
    }, [query]);

    const tierEntries = useMemo(() => filterCatalogTier(entries, pricing, tier), [entries, pricing, tier]);
    const filtered = useMemo(() => {
        const selectedTypes: readonly TypeName[] | undefined = TYPE_FILTERS.find((row) => row.key === type)?.types;
        return filterEntries(tierEntries, debouncedQuery).filter(
            (entry) => (!vendor || entry.vendor === vendor) && (!selectedTypes || selectedTypes.includes(entry.type)),
        );
    }, [tierEntries, debouncedQuery, vendor, type]);
    const vendors = VENDOR_ORDER.filter((name) => entries.some((entry) => entry.vendor === name));
    const typeFilters = TYPE_FILTERS.filter((filter) =>
        entries.some((entry) => (filter.types as readonly TypeName[]).includes(entry.type)),
    );
    const selectedTier = tiers.find((row) => row.key === tier);
    const visibleTiers = selectedTier ? [selectedTier] : tiers;
    const pricingBySlug = useMemo(() => new Map(pricing.map((model) => [model.slug, model.pricesByTier])), [pricing]);
    const selectedModel = filtered.find((entry) => entry.shortName === detailModel);
    const hasFilters = Boolean(tier || vendor || type || debouncedQuery);

    function resetFilters() {
        setQuery('');
        setDebouncedQuery('');
        setTier('');
        setVendor('');
        setType('');
    }

    return (
        <>
            <header className="mb-7">
                {embedded && <p className="m-0 mb-2 text-xs font-semibold tracking-wider text-minor-ink">CATALOG</p>}
                <h1 className="m-0 text-3xl font-semibold tracking-tight text-navy">模型清单</h1>
                <p className="m-0 mt-2 text-sm leading-relaxed text-muted-ink">
                    查看价格，选择分组，复制模型名开始调用。
                </p>
                {!embedded && <p className="m-0 mt-2 break-all text-xs text-minor-ink">API：{CUSTOMER_API_BASE_URL}</p>}
            </header>
            <div className="mb-5 flex flex-wrap gap-1.5" role="group" aria-label="模型类型">
                {[{ key: '', label: '全部' }, ...typeFilters].map((filter) => (
                    <button
                        key={filter.key}
                        type="button"
                        aria-pressed={type === filter.key}
                        onClick={() => setType(filter.key as ModelTypeFilter)}
                        className={`min-h-11 cursor-pointer rounded-lg border-0 px-4 py-2 text-sm font-medium transition-colors ${type === filter.key ? 'bg-navy text-paper' : 'bg-transparent text-muted-ink hover:bg-paper-muted hover:text-navy'}`}
                    >
                        {filter.label}
                    </button>
                ))}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.45fr)_minmax(0,0.65fr)]">
                <label className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-ink sm:col-span-2 lg:col-span-1">
                    搜索模型
                    <span className="relative">
                        <Search aria-hidden="true" size={16} className="pointer-events-none absolute left-3 top-3.5" />
                        <input
                            type="search"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="搜索模型名称、API ID 或厂商"
                            className={`${FIELD_CLASS} pl-9`}
                        />
                    </span>
                </label>
                <label htmlFor="model-vendor-filter" className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-ink">
                    厂商
                    <select
                        id="model-vendor-filter"
                        value={vendor}
                        onChange={(event) => setVendor(event.target.value)}
                        className={`${FIELD_CLASS} cursor-pointer`}
                    >
                        <option value="">全部厂商</option>
                        {vendors.map((name) => (
                            <option key={name} value={name}>
                                {name}
                                {VENDOR_META[name].zh ? ` · ${VENDOR_META[name].zh}` : ''}
                            </option>
                        ))}
                    </select>
                </label>
                <label htmlFor="model-tier-filter" className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-ink">
                    API Key 分组
                    <select
                        id="model-tier-filter"
                        value={tier}
                        onChange={(event) => setTier(event.target.value)}
                        className={`${FIELD_CLASS} cursor-pointer`}
                    >
                        <option value="">全部分组</option>
                        {tiers.map((row) => (
                            <option key={row.key} value={row.key}>
                                {row.label}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <div className="my-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-ink">
                <p className="m-0" role="status">
                    {hasFilters ? '筛选结果 ' : '共 '}
                    <strong className="text-navy">{filtered.length}</strong> 个模型，
                    <strong className="text-navy">{new Set(filtered.map((entry) => entry.vendor)).size}</strong> 个厂商
                </p>
                {hasFilters ? (
                    <button
                        type="button"
                        onClick={resetFilters}
                        className="cursor-pointer border-0 bg-transparent py-1 text-xs text-brand-accent hover:underline"
                    >
                        清除筛选
                    </button>
                ) : (
                    <span>人民币 · 使用价格所示分组的 API Key 调用</span>
                )}
            </div>
            {filtered.length === 0 ? (
                <Card className="p-8">
                    <EmptyState
                        title={hasFilters ? '没有匹配的模型' : '暂无可用模型'}
                        body={
                            hasFilters
                                ? '调整类型、厂商或分组，或清除筛选查看全部模型。'
                                : '模型目录暂时不可用，请稍后刷新页面。'
                        }
                    />
                </Card>
            ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {filtered.map((entry) => (
                        <ModelCard
                            key={entry.shortName}
                            entry={entry}
                            tiers={visibleTiers}
                            prices={pricingBySlug.get(entry.shortName) ?? {}}
                            filteredTier={Boolean(selectedTier)}
                            onDetails={() => setDetailModel(entry.shortName)}
                        />
                    ))}
                </div>
            )}
            {selectedModel && (
                <ModelPriceDialog
                    entry={selectedModel}
                    tiers={visibleTiers}
                    prices={pricingBySlug.get(selectedModel.shortName) ?? {}}
                    onClose={() => setDetailModel(null)}
                />
            )}
        </>
    );
}

function CopyModelName({ name }: { name: string }) {
    const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
    useEffect(() => {
        if (status === 'idle') return;
        const timeout = setTimeout(() => setStatus('idle'), 2500);
        return () => clearTimeout(timeout);
    }, [status]);
    async function copy() {
        try {
            await navigator.clipboard.writeText(name);
            setStatus('copied');
        } catch {
            setStatus('failed');
        }
    }
    return (
        <span className="relative shrink-0">
            <button
                type="button"
                onClick={copy}
                aria-label={`复制模型名 ${name}`}
                className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted-ink transition-colors hover:bg-paper-muted hover:text-navy"
            >
                {status === 'copied' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            </button>
            <span
                role="status"
                className={
                    status === 'idle'
                        ? 'sr-only'
                        : 'absolute right-0 top-full z-10 w-max max-w-64 rounded border border-brand-border bg-surface px-2 py-1 text-xs text-navy shadow-card'
                }
            >
                {status === 'copied' ? '已复制模型名' : status === 'failed' ? '复制失败，请手动选择模型名复制' : ''}
            </span>
        </span>
    );
}

function ModelCard({
    entry,
    tiers,
    prices,
    filteredTier,
    onDetails,
}: {
    entry: ModelEntry;
    tiers: BrowserTier[];
    prices: Record<string, TierPricing | null>;
    filteredTier: boolean;
    onDetails: () => void;
}) {
    const members = tiers.filter((row) => Object.hasOwn(prices, row.key));
    const displayTier = catalogSummaryTier(tiers, prices);
    const summary = catalogPriceSummary(displayTier ? prices[displayTier.key] : null, entry.type);
    return (
        <Card
            as="article"
            className="flex min-w-0 flex-col gap-5 p-5 shadow-none! transition-shadow hover:shadow-card!"
        >
            <div>
                <div className="flex items-start justify-between gap-2">
                    <h2 className="m-0 min-w-0 select-text break-words pt-2 text-base font-semibold tracking-tight text-navy [overflow-wrap:anywhere]">
                        {entry.shortName}
                    </h2>
                    <CopyModelName name={entry.shortName} />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-ink">
                    <span>{entry.vendor}</span>
                    <span aria-hidden="true">·</span>
                    <span>{TYPE_BADGE[entry.type]}</span>
                </div>
            </div>
            <div className="flex-1" aria-label={`${displayTier?.label ?? '当前分组'}价格摘要`}>
                {summary ? (
                    <>
                        <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1">
                            {summary.rates.map((rate) => (
                                <div key={rate.label}>
                                    <dt className="text-xs text-muted-ink">{rate.label}</dt>
                                    <dd className="m-0 mt-1 break-words text-xl font-semibold tabular-nums tracking-tight text-navy [overflow-wrap:anywhere]">
                                        {`¥${formatTieredPrice(rate.amount)}`}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                        <p className="m-0 mt-2 text-xs text-muted-ink">{summary.unit}</p>
                        {summary.condition && (
                            <p className="m-0 mt-1.5 text-xs leading-relaxed text-muted-ink">{summary.condition}</p>
                        )}
                        {summary.note && (
                            <p className="m-0 mt-1 text-xs leading-relaxed text-muted-ink">{summary.note}</p>
                        )}
                    </>
                ) : (
                    <p className="m-0 py-2 text-sm text-muted-ink">未定价</p>
                )}
                {displayTier && (
                    <p className="m-0 mt-3 break-words text-xs font-medium text-navy">{displayTier.label}</p>
                )}
            </div>
            <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-ink">
                    {filteredTier ? '当前分组' : `${members.length} 个可用分组`}
                </span>
                <button
                    type="button"
                    onClick={onDetails}
                    aria-label={`查看 ${entry.shortName} 的价格详情`}
                    aria-haspopup="dialog"
                    className="inline-flex min-h-11 cursor-pointer items-center gap-1 rounded border-0 bg-transparent px-1 text-sm font-medium text-brand-accent hover:underline"
                >
                    价格详情
                    <ChevronRight size={14} aria-hidden="true" />
                </button>
            </div>
        </Card>
    );
}

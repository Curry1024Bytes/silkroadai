'use client';

/**
 * /models browser — vendor-first catalog.
 *
 * Receives current model memberships and customer prices from the server
 * and renders them grouped by VENDOR first (one section per vendor,
 * each appearing exactly once), with a light type sub-grouping inside each
 * vendor and a per-card capability badge.
 *
 *   - Search over model name / vendor (EN + 中文) / type label
 *   - 200ms debounce so fast typers don't re-filter every keystroke
 *   - Empty-state when the filter narrows everything out
 *   - Tier selection filters both membership and exact-tier retail prices
 *
 * Filtering + grouping are in-memory: the catalog is a few dozen entries,
 * far too small to bother with server-side filter or virtualization.
 */
import { useMemo, useState, useEffect } from 'react';
import {
    type ModelEntry,
    type TypeName,
    type VendorSection,
    TYPE_LABEL,
    TYPE_BADGE,
    VENDOR_META,
    groupByVendor,
    filterEntries,
} from '@/lib/models/categorize';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import type { BrowserModelPricing, BrowserTier } from '@/lib/models/catalog-browser-types';
import type { TierPricing } from '@/lib/models/machine-catalog';
import { formatTieredPrice, isUniformPricingDetails } from '@/lib/models/tiered-pricing-details';
import { CUSTOMER_API_BASE_URL } from '@/lib/public-config';

interface Props {
    entries: ModelEntry[];
    totalModels: number;
    vendorCount: number;
    tiers: BrowserTier[];
    pricing: BrowserModelPricing[];
    embedded?: boolean;
}

export function filterCatalogTier(entries: ModelEntry[], pricing: BrowserModelPricing[], tier: string) {
    const members = new Set(
        pricing.filter((model) => !tier || Object.hasOwn(model.pricesByTier, tier)).map((model) => model.slug),
    );
    return entries.filter((entry) => members.has(entry.shortName));
}

export function ModelsBrowser({ entries, tiers, pricing, embedded = false }: Props) {
    const [tier, setTier] = useState('');
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');

    // 200ms debounce — instant on a single keystroke, no thrash on a burst.
    useEffect(() => {
        const id = setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), 200);
        return () => clearTimeout(id);
    }, [query]);

    const tierEntries = useMemo(() => filterCatalogTier(entries, pricing, tier), [entries, pricing, tier]);
    const filtered = useMemo(() => filterEntries(tierEntries, debouncedQuery), [tierEntries, debouncedQuery]);
    const sections = useMemo(() => groupByVendor(filtered), [filtered]);
    const filteredTotal = filtered.length;
    const tierVendorCount = new Set(tierEntries.map((entry) => entry.vendor)).size;
    const selectedTier = tiers.find((row) => row.key === tier);
    const pricingBySlug = new Map(pricing.map((model) => [model.slug, model.pricesByTier]));

    return (
        <>
            <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    {embedded && <p className="m-0 mb-1 text-xs font-semibold text-portal-gold">CATALOG</p>}
                    <h1 className="m-0 text-3xl font-semibold text-navy">模型清单</h1>
                    <p className="m-0 mt-2 text-sm leading-relaxed text-muted-ink">
                        按档次查看模型与价格，使用对应档次的 API Key 调用。
                    </p>
                    {!embedded && (
                        <p className="m-0 mt-2 text-xs text-minor-ink break-all">API：{CUSTOMER_API_BASE_URL}</p>
                    )}
                </div>
                <div className="w-full sm:w-64 sm:shrink-0">
                    <label htmlFor="model-tier-filter" className="mb-1.5 block text-sm font-medium text-navy">
                        档次筛选
                    </label>
                    <select
                        id="model-tier-filter"
                        value={tier}
                        onChange={(event) => setTier(event.target.value)}
                        className="min-h-11 w-full cursor-pointer rounded-lg border border-brand-border bg-surface px-3 py-2 text-sm text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-accent"
                    >
                        <option value="">全部档次</option>
                        {tiers.map((row) => (
                            <option key={row.key} value={row.key}>
                                {row.label}
                            </option>
                        ))}
                    </select>
                </div>
            </header>
            <div className="flex flex-col gap-2 mb-6">
                <Input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索模型(支持模型名 / 厂商 / 类型)…"
                    aria-label="搜索模型"
                />
                <p className="m-0 text-xs text-muted-ink" role="status">
                    {selectedTier && <>{selectedTier.label} · </>}
                    {debouncedQuery ? (
                        <>
                            筛选结果 {filteredTotal} / {tierEntries.length} 条
                        </>
                    ) : (
                        <>
                            共 <strong className="text-navy">{tierEntries.length}</strong> 个模型，
                            <strong className="text-navy">{tierVendorCount}</strong> 个厂商
                        </>
                    )}
                </p>
            </div>

            {sections.length === 0 ? (
                <Card>
                    <EmptyState
                        title={debouncedQuery ? `没有匹配「${query}」的模型` : tier ? '该档次暂无模型' : '暂无可用模型'}
                        body={
                            debouncedQuery
                                ? '试试其他关键词,或清空搜索框查看全部。'
                                : tier
                                  ? '可以切换其他档次查看。'
                                  : '模型目录暂时不可用,请稍后刷新页面。'
                        }
                    />
                </Card>
            ) : (
                <div className="flex flex-col gap-10">
                    {sections.map((section) => (
                        <VendorSectionBlock
                            key={section.vendor}
                            section={section}
                            tiers={selectedTier ? [selectedTier] : tiers}
                            pricingBySlug={pricingBySlug}
                        />
                    ))}
                </div>
            )}
        </>
    );
}

function VendorSectionBlock({
    section,
    tiers,
    pricingBySlug,
}: {
    section: VendorSection;
    tiers: BrowserTier[];
    pricingBySlug: Map<string, Record<string, TierPricing | null>>;
}) {
    const meta = VENDOR_META[section.vendor];
    return (
        <section>
            <header className="flex items-center gap-3 mb-4 pb-3 border-b border-brand-border">
                <span
                    aria-hidden="true"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-navy text-lg font-semibold text-paper"
                >
                    {meta.initial}
                </span>
                <div className="min-w-0">
                    <h2 className="m-0 text-xl font-semibold text-navy leading-tight">{section.vendor}</h2>
                    {meta.zh && <p className="m-0 text-xs text-minor-ink">{meta.zh}</p>}
                </div>
                <span className="ml-auto shrink-0 text-xs font-medium text-muted-ink bg-paper-muted border border-brand-border rounded-full px-2.5 py-1">
                    {section.total} 个模型
                </span>
            </header>

            <div className="flex flex-col gap-5">
                {section.types.map((bucket) => (
                    <div key={bucket.type}>
                        <h3 className="m-0 mb-2.5 text-xs font-semibold text-muted-ink">
                            {TYPE_LABEL[bucket.type]}{' '}
                            <span className="text-minor-ink font-normal normal-case">· {bucket.entries.length}</span>
                        </h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                            {bucket.entries.map((m) => (
                                <ModelCard
                                    key={m.shortName}
                                    entry={m}
                                    tiers={tiers}
                                    prices={pricingBySlug.get(m.shortName) ?? {}}
                                />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}

const TYPE_CHIP_CLASS: Record<TypeName, string> = {
    chat: 'bg-paper-muted text-muted-ink border-brand-border',
    vision: 'bg-paper-muted text-muted-ink border-brand-border',
    'image-gen': 'bg-status-warning-bg text-status-warning-text border-status-warning-border',
    video: 'bg-status-success-bg text-status-success-text border-status-success-border',
    audio: 'bg-paper-muted text-muted-ink border-brand-border',
    embedding: 'bg-paper-muted text-muted-ink border-brand-border',
};

function ModelCard({
    entry,
    tiers,
    prices,
}: {
    entry: ModelEntry;
    tiers: BrowserTier[];
    prices: Record<string, TierPricing | null>;
}) {
    const [copied, setCopied] = useState(false);
    const showCanonical = entry.shortName !== entry.canonicalName;

    async function handleCopy() {
        try {
            await navigator.clipboard.writeText(entry.shortName);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Older browsers / non-https — silently swallow; user can copy
            // manually from the visible card text.
        }
    }

    return (
        <Card as="article" className="px-3.5 py-3 flex flex-col gap-1.5">
            <div className="font-mono text-sm font-semibold text-navy break-all">{entry.shortName}</div>
            {showCanonical && (
                <div className="font-mono text-[11px] text-minor-ink break-all">{entry.canonicalName}</div>
            )}
            <div className="my-2 space-y-3">
                {tiers
                    .filter((row) => Object.hasOwn(prices, row.key))
                    .map((row) => (
                        <section
                            key={row.key}
                            aria-label={`${row.label}价格`}
                            className="border-t border-brand-border pt-2.5"
                        >
                            <h4 className="m-0 mb-2 text-xs font-semibold text-navy break-words">{row.label}</h4>
                            <ModelTierPrices price={prices[row.key]} type={entry.type} />
                        </section>
                    ))}
            </div>
            <div className="flex items-center gap-2 mt-1">
                <span
                    className={['text-[11px] px-2 py-0.5 rounded-full border', TYPE_CHIP_CLASS[entry.type]].join(' ')}
                >
                    {TYPE_BADGE[entry.type]}
                </span>
                <button
                    type="button"
                    onClick={handleCopy}
                    aria-label={`复制模型名 ${entry.shortName}`}
                    className={[
                        'ml-auto text-[11px] px-2.5 py-1 rounded-lg',
                        'border border-transparent transition-colors duration-150 ease-brand cursor-pointer',
                        copied
                            ? 'bg-status-success-bg text-status-success-text border-status-success-border'
                            : 'bg-navy text-paper hover:bg-navy-strong',
                    ].join(' ')}
                >
                    {copied ? '已复制 ✓' : '复制'}
                </button>
            </div>
        </Card>
    );
}

export function ModelTierPrices({ price, type }: { price: TierPricing | null; type: TypeName }) {
    if (!price) return <p className="m-0 text-xs text-muted-ink">未定价</p>;
    const details = price.billing_details;
    if (details && !isUniformPricingDetails(details)) {
        return (
            <a href="/pricing" className="text-xs text-brand-accent underline">
                按用量计费 · 查看价格
            </a>
        );
    }
    const rates = details?.tiers[0].rates;
    const rows: [string, number | null | undefined][] = [
        ['输入', rates?.input ?? price.input_cny_per_1m],
        ['输出', rates?.output ?? price.output_cny_per_1m],
        ['缓存读取', rates?.cache_read],
        [rates?.cache_write_1h != null ? '缓存写入 / 5 分钟' : '缓存写入', rates?.cache_write],
        ['缓存写入 / 1 小时', rates?.cache_write_1h],
    ];
    const tokenRows = rows.filter((row): row is [string, number] => row[1] != null);
    if (price.per_image_cny == null && tokenRows.length === 0) {
        return <p className="m-0 text-xs text-muted-ink">未定价</p>;
    }
    return (
        <>
            {price.per_image_cny != null && (
                <p className="m-0 text-sm font-semibold text-navy">
                    {`¥${formatTieredPrice(price.per_image_cny)}`}
                    <span className="font-normal text-xs text-muted-ink"> / {type === 'image-gen' ? '张' : '次'}</span>
                </p>
            )}
            {tokenRows.length > 0 && (
                <>
                    <p className="m-0 mb-1.5 text-[11px] text-minor-ink">元 / 百万 token</p>
                    <dl className="m-0 space-y-1 text-xs">
                        {tokenRows.map(([label, amount]) => (
                            <div key={label} className="flex justify-between gap-3">
                                <dt className="text-muted-ink">{label}</dt>
                                <dd className="m-0 font-medium tabular-nums text-navy">{`¥${formatTieredPrice(amount)}`}</dd>
                            </div>
                        ))}
                    </dl>
                </>
            )}
        </>
    );
}

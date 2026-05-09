'use client';

/**
 * W6 D3 — /models browser client component.
 *
 * Receives the full grouped model structure from the server page (one ISR
 * pass per 60s) and provides:
 *   - Search input over shortName / canonicalName / vendor
 *   - 200ms debounce so fast typers don't trigger a re-filter every keystroke
 *   - 5 type-sections (chat / vision / audio / embedding / image-gen) with
 *     vendor sub-sections + model card grid
 *   - Empty-state when filter narrows everything out
 *
 * Filtering is in-memory — total payload from new-api is ~379 entries (W3
 * D2 F5), which serializes to ~25-35KB of JSON inlined in the SSR HTML.
 * Cheap enough that we don't bother with server-side filter or virtualization.
 */
import { useMemo, useState, useEffect } from 'react';
import {
    type GroupedModels,
    type TypeName,
    type VendorName,
    type ModelEntry,
    TYPE_ORDER,
    TYPE_LABEL,
    VENDOR_ORDER,
    filterGrouped,
    countGrouped,
} from '@/lib/models/categorize';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';

interface Props {
    grouped: GroupedModels;
    totalModels: number;
    vendorCount: number;
}

export function ModelsBrowser({ grouped, totalModels, vendorCount }: Props) {
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');

    // 200ms debounce — strikes the balance between feeling instant on a
    // single keystroke and avoiding 5 re-filters during a 5-char input.
    useEffect(() => {
        const id = setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), 200);
        return () => clearTimeout(id);
    }, [query]);

    const filtered: GroupedModels = useMemo(() => filterGrouped(grouped, debouncedQuery), [grouped, debouncedQuery]);

    const typesWithContent = TYPE_ORDER.filter((t) => filtered[t] && Object.keys(filtered[t]!).length > 0);
    const filteredTotal = useMemo(() => countGrouped(filtered), [filtered]);

    return (
        <>
            <div className="flex flex-col gap-2 mb-6">
                <Input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索模型(支持模型名 / 厂商名)…"
                    aria-label="搜索模型"
                />
                <p className="m-0 text-xs text-muted-ink">
                    {debouncedQuery ? (
                        <>
                            筛选结果 {filteredTotal} / {totalModels} 条
                        </>
                    ) : (
                        <>
                            共 <strong className="text-navy">{totalModels}</strong> 个模型,
                            <strong className="text-navy">{vendorCount}</strong> 个厂商
                        </>
                    )}
                </p>
            </div>

            {typesWithContent.length === 0 ? (
                <Card>
                    <EmptyState title={`没有匹配「${query}」的模型`} body="试试其他关键词,或清空搜索框查看全部。" />
                </Card>
            ) : (
                typesWithContent.map((type) => <TypeSection key={type} type={type} typeBucket={filtered[type]!} />)
            )}
        </>
    );
}

function TypeSection({ type, typeBucket }: { type: TypeName; typeBucket: Partial<Record<VendorName, ModelEntry[]>> }) {
    const vendorsInOrder = VENDOR_ORDER.filter((v) => typeBucket[v] && typeBucket[v]!.length > 0);

    return (
        <section className="mb-8">
            <h2 className="m-0 mb-4 pb-2 text-lg font-semibold text-navy border-b-2 border-brand-accent">
                {TYPE_LABEL[type]}
            </h2>
            {vendorsInOrder.map((vendor) => (
                <VendorBlock key={vendor} vendor={vendor} entries={typeBucket[vendor]!} />
            ))}
        </section>
    );
}

function VendorBlock({ vendor, entries }: { vendor: VendorName; entries: ModelEntry[] }) {
    return (
        <div className="mb-5">
            <h3 className="m-0 mb-2.5 text-xs font-semibold uppercase tracking-wide text-muted-ink">
                {vendor} <span className="text-minor-ink font-normal normal-case">· {entries.length}</span>
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {entries.map((m) => (
                    <ModelCard key={m.shortName} entry={m} />
                ))}
            </div>
        </div>
    );
}

function ModelCard({ entry }: { entry: ModelEntry }) {
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
            <div className="flex items-center gap-2 mt-1">
                <span
                    className={[
                        'text-[11px] px-2 py-0.5 rounded-full',
                        'bg-paper-muted text-muted-ink border border-brand-border',
                    ].join(' ')}
                >
                    {entry.vendor}
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

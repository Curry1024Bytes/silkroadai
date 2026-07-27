'use client';

/**
 * /models browser — vendor-first catalog.
 *
 * Receives the full flat `ModelEntry[]` from the server page (one ISR pass
 * per 60s) and renders it grouped by VENDOR first (one section per vendor,
 * each appearing exactly once), with a light type sub-grouping inside each
 * vendor and a per-card capability badge.
 *
 *   - Search over model name / vendor (EN + 中文) / type label
 *   - 200ms debounce so fast typers don't re-filter every keystroke
 *   - Empty-state when the filter narrows everything out
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

interface Props {
    entries: ModelEntry[];
    totalModels: number;
    vendorCount: number;
}

export function ModelsBrowser({ entries, totalModels, vendorCount }: Props) {
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');

    // 200ms debounce — instant on a single keystroke, no thrash on a burst.
    useEffect(() => {
        const id = setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), 200);
        return () => clearTimeout(id);
    }, [query]);

    const filtered = useMemo(() => filterEntries(entries, debouncedQuery), [entries, debouncedQuery]);
    const sections = useMemo(() => groupByVendor(filtered), [filtered]);
    const filteredTotal = filtered.length;

    return (
        <>
            <div className="flex flex-col gap-2 mb-6">
                <Input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索模型(支持模型名 / 厂商 / 类型)…"
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

            {sections.length === 0 ? (
                <Card>
                    <EmptyState
                        title={debouncedQuery ? `没有匹配「${query}」的模型` : '暂无可用模型'}
                        body={
                            debouncedQuery
                                ? '试试其他关键词,或清空搜索框查看全部。'
                                : '模型目录暂时不可用,请稍后刷新页面。'
                        }
                    />
                </Card>
            ) : (
                <div className="flex flex-col gap-10">
                    {sections.map((section) => (
                        <VendorSectionBlock key={section.vendor} section={section} />
                    ))}
                </div>
            )}
        </>
    );
}

function VendorSectionBlock({ section }: { section: VendorSection }) {
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
                                <ModelCard key={m.shortName} entry={m} />
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

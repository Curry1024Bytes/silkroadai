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
// TypeName, VendorName, ModelEntry are referenced by the helper components
// below (TypeSection / VendorBlock / ModelCard), not by the top-level
// ModelsBrowser. Keep them imported in one place.

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

    const filtered: GroupedModels = useMemo(
        () => filterGrouped(grouped, debouncedQuery),
        [grouped, debouncedQuery],
    );

    const typesWithContent = TYPE_ORDER.filter(
        (t) => filtered[t] && Object.keys(filtered[t]!).length > 0,
    );
    const filteredTotal = useMemo(() => countGrouped(filtered), [filtered]);

    return (
        <>
            <div
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    marginBottom: 24,
                }}
            >
                <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索模型(支持模型名 / 厂商名)…"
                    aria-label="搜索模型"
                    style={{
                        width: '100%',
                        padding: '12px 14px',
                        border: '1px solid #e5e8ee',
                        borderRadius: 6,
                        fontSize: 14,
                        background: '#fff',
                        outline: 'none',
                    }}
                />
                <p style={{ margin: 0, fontSize: 12, color: '#5a6478' }}>
                    {debouncedQuery ? (
                        <>
                            筛选结果 {filteredTotal} / {totalModels} 条
                        </>
                    ) : (
                        <>
                            共 <strong>{totalModels}</strong> 个模型,
                            <strong>{vendorCount}</strong> 个厂商
                        </>
                    )}
                </p>
            </div>

            {typesWithContent.length === 0 ? (
                <div
                    style={{
                        background: '#fff',
                        border: '1px dashed #e5e8ee',
                        borderRadius: 6,
                        padding: 40,
                        textAlign: 'center',
                        color: '#8a92a4',
                        fontSize: 14,
                    }}
                >
                    没有匹配「{query}」的模型。试试其他关键词。
                </div>
            ) : (
                typesWithContent.map((type) => (
                    <TypeSection key={type} type={type} typeBucket={filtered[type]!} />
                ))
            )}
        </>
    );
}

function TypeSection({
    type,
    typeBucket,
}: {
    type: TypeName;
    typeBucket: Partial<Record<VendorName, ModelEntry[]>>;
}) {
    const vendorsInOrder = VENDOR_ORDER.filter((v) => typeBucket[v] && typeBucket[v]!.length > 0);

    return (
        <section style={{ marginBottom: 32 }}>
            <h2
                style={{
                    margin: '0 0 14px',
                    fontSize: 18,
                    color: '#0a1535',
                    paddingBottom: 8,
                    borderBottom: '2px solid #0a1535',
                }}
            >
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
        <div style={{ marginBottom: 18 }}>
            <h3
                style={{
                    margin: '0 0 10px',
                    fontSize: 13,
                    color: '#5a6478',
                    fontWeight: 600,
                    letterSpacing: '0.02em',
                    textTransform: 'uppercase',
                }}
            >
                {vendor}{' '}
                <span style={{ color: '#8a92a4', fontWeight: 400, textTransform: 'none' }}>
                    · {entries.length}
                </span>
            </h3>
            <div
                style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                    gap: 10,
                }}
            >
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
        <article
            style={{
                background: '#fff',
                border: '1px solid #e5e8ee',
                borderRadius: 6,
                padding: '12px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
            }}
        >
            <div
                style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 13,
                    color: '#0a1535',
                    fontWeight: 600,
                    wordBreak: 'break-all',
                }}
            >
                {entry.shortName}
            </div>
            {showCanonical && (
                <div
                    style={{
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        fontSize: 11,
                        color: '#8a92a4',
                        wordBreak: 'break-all',
                    }}
                >
                    {entry.canonicalName}
                </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <span
                    style={{
                        fontSize: 11,
                        background: '#f5f7fa',
                        color: '#5a6478',
                        padding: '2px 8px',
                        borderRadius: 10,
                        border: '1px solid #e5e8ee',
                    }}
                >
                    {entry.vendor}
                </span>
                <button
                    type="button"
                    onClick={handleCopy}
                    style={{
                        marginLeft: 'auto',
                        fontSize: 11,
                        padding: '3px 10px',
                        background: copied ? '#1a8a4a' : '#0a1535',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 4,
                        cursor: 'pointer',
                    }}
                    aria-label={`复制模型名 ${entry.shortName}`}
                >
                    {copied ? '已复制 ✓' : '复制'}
                </button>
            </div>
        </article>
    );
}

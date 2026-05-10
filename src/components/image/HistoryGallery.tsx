'use client';

/**
 * HistoryGallery (PR-T2) — paginated thumbnail wall.
 *
 * Default = collapsed (for an under-the-fold compact look). Expanded:
 *   - Tabs [全部] [收藏]
 *   - 4-col grid (2-col on mobile)
 *   - Cursor pagination via useSWRInfinite
 *   - Per-thumbnail click → ImageModal via consumer-supplied handler
 */
import { useState } from 'react';
import useSWRInfinite from 'swr/infinite';
import type { ImageGenerationItem, ListPage } from './types';

type Filter = 'all' | 'favorite';

async function fetchPage(url: string): Promise<ListPage> {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`${r.status}`);
    return (await r.json()) as ListPage;
}

interface Props {
    /** Items already shown above (the latest result) — we hide them in
     *  the gallery to avoid duplication. */
    suppressIds?: string[];
    onOpen: (item: ImageGenerationItem, index: number) => void;
}

const PAGE_SIZE = 20;

export function HistoryGallery({ suppressIds = [], onOpen }: Props) {
    const [open, setOpen] = useState(false);
    const [filter, setFilter] = useState<Filter>('all');

    const getKey = (pageIndex: number, prev: ListPage | null) => {
        if (!open) return null;
        if (prev && !prev.has_more) return null;
        const cursor = prev?.next_cursor ? `&cursor=${encodeURIComponent(prev.next_cursor)}` : '';
        return `/api/portal/image/list?filter=${filter}&limit=${PAGE_SIZE}${cursor}`;
    };

    const { data, size, setSize, isValidating, mutate } = useSWRInfinite<ListPage>(getKey, fetchPage, {
        revalidateFirstPage: false,
    });

    const items = (data?.flatMap((p) => p.items) ?? []).filter((it) => !suppressIds.includes(it.id));
    const lastPage = data?.[data.length - 1];
    const hasMore = lastPage?.has_more ?? false;

    return (
        <section aria-label="生成历史" className="mt-8 border-t border-brand-border pt-6">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    aria-expanded={open}
                    className={[
                        'flex items-center gap-1.5 text-sm cursor-pointer',
                        'text-muted-ink hover:text-navy',
                        'transition-colors duration-150 ease-brand',
                    ].join(' ')}
                >
                    <span
                        aria-hidden="true"
                        className="inline-block transition-transform duration-150 ease-brand"
                        style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
                    >
                        ▸
                    </span>
                    <span className="font-medium">{open ? '收起历史' : '展开历史'}</span>
                </button>

                {open && (
                    <div role="tablist" aria-label="历史筛选" className="inline-flex gap-1.5">
                        <TabBtn active={filter === 'all'} onClick={() => setFilter('all')}>
                            全部
                        </TabBtn>
                        <TabBtn active={filter === 'favorite'} onClick={() => setFilter('favorite')}>
                            收藏
                        </TabBtn>
                    </div>
                )}
            </div>

            {open && (
                <div className="mt-5">
                    {!data ? (
                        <div className="text-sm text-muted-ink py-6 text-center">加载中…</div>
                    ) : items.length === 0 ? (
                        <div className="text-sm text-muted-ink py-10 text-center">
                            {filter === 'favorite' ? '还没收藏过图' : '还没生成过图'}
                        </div>
                    ) : (
                        <ul className="list-none p-0 m-0 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                            {items.map((it) =>
                                it.image_urls.map((url, i) => (
                                    <li key={`${it.id}-${i}`}>
                                        <button
                                            type="button"
                                            onClick={() => onOpen(it, i)}
                                            aria-label={`查看 ${it.prompt.slice(0, 30)}`}
                                            className={[
                                                'group relative block w-full aspect-square overflow-hidden rounded-lg cursor-zoom-in',
                                                'bg-paper-muted border border-brand-border',
                                                'transition-transform duration-150 ease-brand hover:-translate-y-0.5',
                                            ].join(' ')}
                                        >
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img
                                                src={url}
                                                alt={it.prompt.slice(0, 60)}
                                                loading="lazy"
                                                className="absolute inset-0 w-full h-full object-cover"
                                            />
                                            {it.is_favorite ? (
                                                <span
                                                    aria-label="已收藏"
                                                    className="absolute top-1.5 right-1.5 text-brand-accent text-base bg-surface/80 rounded px-1"
                                                >
                                                    ★
                                                </span>
                                            ) : null}
                                        </button>
                                    </li>
                                )),
                            )}
                        </ul>
                    )}

                    {hasMore && (
                        <div className="mt-4 text-center">
                            <button
                                type="button"
                                onClick={() => setSize(size + 1)}
                                disabled={isValidating}
                                className={[
                                    'px-4 py-2 text-sm cursor-pointer rounded-lg',
                                    'border border-brand-border bg-surface text-muted-ink',
                                    'hover:border-brand-accent hover:text-navy',
                                    'transition-colors duration-150 ease-brand',
                                    isValidating ? 'opacity-50 cursor-wait' : '',
                                ].join(' ')}
                            >
                                {isValidating ? '加载中…' : '加载更多'}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* mutate exposed via window to allow studio to refresh after generate */}
            <RefreshHook mutate={mutate} />
        </section>
    );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={active}
            onClick={onClick}
            className={[
                'px-3 py-1.5 text-xs rounded-lg cursor-pointer',
                'transition-colors duration-150 ease-brand',
                active ? 'bg-paper-muted text-navy font-medium' : 'text-muted-ink hover:text-navy',
            ].join(' ')}
        >
            {children}
        </button>
    );
}

/** Tiny side-effect-only component that hangs the SWR mutate fn off
 *  window.__pr_t2_history_mutate__ so the studio orchestrator can
 *  refresh history after a successful generate. Avoids prop-drilling
 *  the mutate fn through the studio's already-busy state surface. */
function RefreshHook({ mutate }: { mutate: () => Promise<unknown> }) {
    if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>).__pr_t2_history_mutate__ = mutate;
    }
    return null;
}

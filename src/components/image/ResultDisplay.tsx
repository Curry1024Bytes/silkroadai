'use client';

/**
 * ResultDisplay (PR-T2) — most-recent generation grid (1-4 images).
 *
 * Each tile: image thumbnail + hover/focus actions (zoom / favorite /
 * download / delete). Tiles are responsive (1 col mobile, up to N cols
 * desktop). Click anywhere on the tile (except the action buttons)
 * opens the modal for full-size viewing.
 */
import { useState } from 'react';
import type { ImageGenerationItem } from './types';

interface Props {
    item: ImageGenerationItem;
    onOpenModal: (item: ImageGenerationItem, initialIndex: number) => void;
    onToggleFavorite: (id: string, next: boolean) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
}

export function ResultDisplay({ item, onOpenModal, onToggleFavorite, onDelete }: Props) {
    const [favPending, setFavPending] = useState(false);
    const [delPending, setDelPending] = useState(false);
    const [isFavorite, setIsFavorite] = useState(item.is_favorite);

    async function handleFav() {
        if (favPending) return;
        setFavPending(true);
        const next = !isFavorite;
        try {
            await onToggleFavorite(item.id, next);
            setIsFavorite(next);
        } finally {
            setFavPending(false);
        }
    }

    async function handleDelete() {
        if (delPending) return;
        if (!window.confirm('删除这次生成?')) return;
        setDelPending(true);
        try {
            await onDelete(item.id);
        } finally {
            setDelPending(false);
        }
    }

    const cols = Math.min(item.image_urls.length, 4);
    const colsClass =
        cols === 1
            ? 'grid-cols-1'
            : cols === 2
              ? 'grid-cols-1 sm:grid-cols-2'
              : cols === 3
                ? 'grid-cols-1 sm:grid-cols-3'
                : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4';

    return (
        <section aria-label="最新生成结果" className="w-full">
            <div className={`grid ${colsClass} gap-3`}>
                {item.image_urls.map((url, i) => (
                    <Tile
                        key={url + i}
                        url={url}
                        alt={`${item.prompt.slice(0, 40)}${item.prompt.length > 40 ? '…' : ''} #${i + 1}`}
                        onZoom={() => onOpenModal(item, i)}
                    />
                ))}
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
                <p className="m-0 text-xs text-muted-ink truncate flex-1 min-w-0" title={item.prompt}>
                    {item.prompt}
                </p>
                <div className="flex items-center gap-2 shrink-0">
                    <ActionButton
                        ariaLabel={isFavorite ? '取消收藏' : '收藏'}
                        onClick={handleFav}
                        loading={favPending}
                        active={isFavorite}
                    >
                        {isFavorite ? '★' : '☆'}
                    </ActionButton>
                    <ActionButton ariaLabel="删除" onClick={handleDelete} loading={delPending} danger>
                        🗑
                    </ActionButton>
                </div>
            </div>
        </section>
    );
}

function Tile({ url, alt, onZoom }: { url: string; alt: string; onZoom: () => void }) {
    return (
        <button
            type="button"
            onClick={onZoom}
            aria-label={`放大查看 ${alt}`}
            className={[
                'group relative block w-full aspect-square overflow-hidden rounded-xl cursor-zoom-in',
                'bg-paper-muted border border-brand-border',
                'transition-transform duration-150 ease-brand hover:-translate-y-0.5',
            ].join(' ')}
        >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={alt} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
            <span
                aria-hidden="true"
                className={[
                    'absolute inset-x-0 bottom-0 px-3 py-2',
                    'bg-gradient-to-t from-navy-strong/60 to-transparent',
                    'text-paper text-xs opacity-0 group-hover:opacity-100',
                    'transition-opacity duration-150 ease-brand',
                ].join(' ')}
            >
                点击放大
            </span>
        </button>
    );
}

interface ActionBtnProps {
    ariaLabel: string;
    onClick: () => void;
    loading?: boolean;
    active?: boolean;
    danger?: boolean;
    children: React.ReactNode;
}

function ActionButton({ ariaLabel, onClick, loading, active, danger, children }: ActionBtnProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={loading}
            aria-label={ariaLabel}
            className={[
                'min-w-[44px] min-h-[44px] flex items-center justify-center cursor-pointer',
                'rounded-lg border text-base',
                'transition-colors duration-150 ease-brand',
                active
                    ? 'border-brand-accent bg-paper-muted text-brand-accent'
                    : danger
                      ? 'border-brand-border bg-surface text-muted-ink hover:border-status-error-border hover:text-status-error-text'
                      : 'border-brand-border bg-surface text-muted-ink hover:border-brand-accent',
                loading ? 'opacity-50 cursor-wait' : '',
            ].join(' ')}
        >
            {children}
        </button>
    );
}

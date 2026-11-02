'use client';

/**
 * ImageModal (PR-T2) — fullscreen viewer for a single generation.
 *
 * - Black-80 backdrop, clickable to close
 * - ESC closes
 * - Trap focus within the dialog (basic — first/last focusable cycle)
 * - Sidebar with prompt / model / size / count / cost / created_at +
 *   actions (download / favorite toggle / delete / copy prompt)
 * - Multi-image gallery: arrow keys + Prev/Next buttons
 */
import { useEffect, useRef, useState } from 'react';
import type { ImageGenerationItem } from './types';
import { intlLocale } from '@/lib/i18n';
import { useLocale, useMessages } from '@/lib/i18n/client';
import { imageMessages } from '@/lib/i18n/messages/image';

interface Props {
    item: ImageGenerationItem | null;
    initialIndex: number;
    onClose: () => void;
    onToggleFavorite: (id: string, next: boolean) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
}

export function ImageModal({ item, initialIndex, onClose, onToggleFavorite, onDelete }: Props) {
    const m = useMessages(imageMessages).modal;
    const locale = intlLocale(useLocale());
    const [index, setIndex] = useState(initialIndex);
    const [isFavorite, setIsFavorite] = useState(item?.is_favorite ?? false);
    const [favPending, setFavPending] = useState(false);
    const [delPending, setDelPending] = useState(false);
    const [copyToast, setCopyToast] = useState(false);
    const dialogRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        setIndex(initialIndex);
    }, [initialIndex]);

    useEffect(() => {
        if (item) setIsFavorite(item.is_favorite);
    }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!item) return;
        function onKey(e: KeyboardEvent) {
            if (e.key === 'Escape') onClose();
            if (!item) return;
            if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, item.image_urls.length - 1));
            if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
        }
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [item, onClose]);

    useEffect(() => {
        if (item && dialogRef.current) {
            dialogRef.current.focus();
        }
    }, [item]);

    if (!item) return null;
    const url = item.image_urls[index] ?? item.image_urls[0];
    const total = item.image_urls.length;

    async function handleFav() {
        if (favPending) return;
        setFavPending(true);
        const next = !isFavorite;
        try {
            await onToggleFavorite(item!.id, next);
            setIsFavorite(next);
        } finally {
            setFavPending(false);
        }
    }

    async function handleDel() {
        if (delPending) return;
        if (!window.confirm(m.confirmDelete)) return;
        setDelPending(true);
        try {
            await onDelete(item!.id);
            onClose();
        } finally {
            setDelPending(false);
        }
    }

    function handleCopyPrompt() {
        navigator.clipboard.writeText(item!.prompt).then(
            () => {
                setCopyToast(true);
                setTimeout(() => setCopyToast(false), 1500);
            },
            () => undefined,
        );
    }

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={m.aria}
            ref={dialogRef}
            tabIndex={-1}
            onClick={onClose}
            className={[
                'fixed inset-0 z-50',
                'bg-navy-strong/80 backdrop-blur-sm',
                'flex items-center justify-center p-4 sm:p-8',
            ].join(' ')}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                className={[
                    'relative w-full max-w-6xl max-h-full',
                    'flex flex-col lg:flex-row gap-4',
                    'bg-surface rounded-xl overflow-hidden',
                ].join(' ')}
            >
                {/* Image area */}
                <div className="relative flex-1 bg-navy-strong flex items-center justify-center min-h-[320px]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={url}
                        alt={`${item.prompt.slice(0, 60)} #${index + 1}`}
                        className="max-w-full max-h-[80vh] object-contain"
                    />
                    {total > 1 && (
                        <>
                            <NavBtn
                                ariaLabel={m.prev}
                                onClick={() => setIndex((i) => Math.max(i - 1, 0))}
                                disabled={index === 0}
                                side="left"
                            >
                                ‹
                            </NavBtn>
                            <NavBtn
                                ariaLabel={m.next}
                                onClick={() => setIndex((i) => Math.min(i + 1, total - 1))}
                                disabled={index === total - 1}
                                side="right"
                            >
                                ›
                            </NavBtn>
                            <span className="absolute bottom-3 left-1/2 -translate-x-1/2 px-2.5 py-1 bg-navy-strong/70 text-paper text-xs rounded">
                                {index + 1} / {total}
                            </span>
                        </>
                    )}
                </div>

                {/* Sidebar */}
                <aside className="w-full lg:w-[300px] shrink-0 px-5 py-5 overflow-y-auto">
                    <h3 id="image-modal-prompt" className="m-0 mb-2 text-sm font-semibold text-navy">
                        Prompt
                    </h3>
                    <p className="m-0 mb-4 text-sm text-muted-ink leading-relaxed whitespace-pre-wrap break-words">
                        {item.prompt}
                    </p>

                    <Field label={m.model} value={item.model_name} />
                    <Field label={m.size} value={item.size} />
                    <Field label={m.count} value={String(item.count)} />
                    <Field label={m.cost} value={`$${item.cost_usd.toFixed(4)}`} />
                    <Field
                        label={m.time}
                        value={new Date(item.created_at).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}
                    />
                    <Field
                        label={m.expires}
                        value={
                            item.expires_at
                                ? new Date(item.expires_at).toLocaleDateString(locale, { timeZone: 'Asia/Shanghai' })
                                : m.permanent
                        }
                    />

                    <div className="mt-5 flex flex-wrap gap-2">
                        <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            download
                            className={[
                                'px-3.5 py-2 rounded-lg text-xs font-medium cursor-pointer',
                                'border border-navy bg-navy text-paper no-underline',
                                'hover:bg-navy-strong transition-colors duration-150 ease-brand',
                            ].join(' ')}
                        >
                            {m.download}
                        </a>
                        <button
                            type="button"
                            onClick={handleFav}
                            disabled={favPending}
                            className={[
                                'px-3.5 py-2 rounded-lg text-xs cursor-pointer',
                                'border transition-colors duration-150 ease-brand',
                                isFavorite
                                    ? 'border-brand-accent bg-paper-muted text-brand-accent'
                                    : 'border-brand-border bg-surface text-muted-ink hover:border-brand-accent',
                            ].join(' ')}
                        >
                            {isFavorite ? m.favorited : m.favorite}
                        </button>
                        <button
                            type="button"
                            onClick={handleCopyPrompt}
                            className="px-3.5 py-2 rounded-lg text-xs cursor-pointer border border-brand-border bg-surface text-muted-ink hover:border-brand-accent"
                        >
                            {copyToast ? m.copied : m.copyPrompt}
                        </button>
                        <button
                            type="button"
                            onClick={handleDel}
                            disabled={delPending}
                            className="px-3.5 py-2 rounded-lg text-xs cursor-pointer border border-brand-border bg-surface text-muted-ink hover:border-status-error-border hover:text-status-error-text"
                        >
                            {m.delete}
                        </button>
                    </div>
                </aside>

                {/* Close button (top-right) */}
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={m.close}
                    className="absolute top-2 right-2 w-10 h-10 flex items-center justify-center rounded-lg cursor-pointer bg-surface/90 text-navy hover:bg-paper-muted"
                >
                    ✕
                </button>
            </div>
        </div>
    );
}

function Field({ label, value }: { label: string; value: string }) {
    return (
        <div className="text-xs leading-relaxed">
            <span className="text-muted-ink">{label}:</span> <span className="text-navy break-all">{value}</span>
        </div>
    );
}

function NavBtn({
    ariaLabel,
    onClick,
    disabled,
    side,
    children,
}: {
    ariaLabel: string;
    onClick: () => void;
    disabled?: boolean;
    side: 'left' | 'right';
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={ariaLabel}
            className={[
                'absolute top-1/2 -translate-y-1/2',
                side === 'left' ? 'left-3' : 'right-3',
                'w-11 h-11 flex items-center justify-center rounded-full cursor-pointer',
                'bg-surface/90 text-navy text-2xl font-light',
                'transition-opacity duration-150 ease-brand',
                disabled ? 'opacity-30 cursor-not-allowed' : 'hover:bg-paper-muted',
            ].join(' ')}
        >
            {children}
        </button>
    );
}

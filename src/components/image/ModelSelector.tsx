'use client';

/**
 * ModelSelector (PR-T2) — dropdown of 5 image models.
 *
 * Each row shows: friendly label (Nano Banana / GPT image-2 / etc.) +
 * one-line blurb + per-image ¥ price. Optional badge in top-right
 * (推荐 / 旗舰). Default selection comes from the consumer (the
 * studio orchestrator).
 */
import { useState, useRef, useEffect } from 'react';
import { IMAGE_MODEL_OPTIONS, type ImageModelOption } from '@/data/image-models';

interface Props {
    value: string;
    onChange: (id: string) => void;
    disabled?: boolean;
}

export function ModelSelector({ value, onChange, disabled = false }: Props) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement | null>(null);
    const selected = IMAGE_MODEL_OPTIONS.find((m) => m.id === value) ?? IMAGE_MODEL_OPTIONS[0];

    // Click-outside to close.
    useEffect(() => {
        function onDocClick(e: MouseEvent) {
            if (!ref.current) return;
            if (!ref.current.contains(e.target as Node)) setOpen(false);
        }
        if (open) document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, [open]);

    return (
        <div ref={ref} className="relative inline-block w-full sm:w-auto sm:min-w-[260px]">
            <button
                type="button"
                onClick={() => !disabled && setOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={open}
                disabled={disabled}
                className={[
                    'w-full px-4 py-3 rounded-xl text-left',
                    'bg-surface border border-brand-border shadow-card',
                    'transition-colors duration-150 ease-brand',
                    disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:border-brand-accent',
                ].join(' ')}
            >
                <Row option={selected} active />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-ink" aria-hidden="true">
                    ▾
                </span>
            </button>
            {open && (
                <ul
                    role="listbox"
                    aria-label="选择图像生成模型"
                    className={[
                        'absolute left-0 right-0 mt-1.5 z-20',
                        'bg-surface border border-brand-border shadow-card-strong rounded-xl',
                        'overflow-hidden list-none p-0 m-0',
                    ].join(' ')}
                >
                    {IMAGE_MODEL_OPTIONS.map((m) => {
                        const isActive = m.id === value;
                        return (
                            <li key={m.id}>
                                <button
                                    type="button"
                                    role="option"
                                    aria-selected={isActive}
                                    onClick={() => {
                                        onChange(m.id);
                                        setOpen(false);
                                    }}
                                    className={[
                                        'w-full text-left px-4 py-3 cursor-pointer',
                                        'transition-colors duration-150 ease-brand',
                                        isActive ? 'bg-paper-muted' : 'bg-transparent hover:bg-paper-muted/60',
                                        'border-b border-brand-border last:border-b-0',
                                    ].join(' ')}
                                >
                                    <Row option={m} active={isActive} />
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

function Row({ option, active }: { option: ImageModelOption; active: boolean }) {
    return (
        <span className="block">
            <span className="flex items-baseline justify-between gap-3">
                <span className="font-medium text-navy text-sm">{option.label}</span>
                <span className="text-xs text-muted-ink tabular-nums whitespace-nowrap">
                    ¥{option.pricePerImageCny.toFixed(2)}/张
                </span>
            </span>
            <span className="block mt-0.5 text-xs text-minor-ink leading-relaxed">{option.blurb}</span>
            {option.badge ? (
                <span
                    className={[
                        'inline-block mt-1 px-1.5 py-0.5 text-[10px] rounded',
                        active ? 'bg-brand-accent text-paper' : 'bg-paper-muted text-muted-ink',
                    ].join(' ')}
                >
                    {option.badge}
                </span>
            ) : null}
        </span>
    );
}

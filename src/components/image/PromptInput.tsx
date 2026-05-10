'use client';

/**
 * PromptInput (PR-T2) — multi-line textarea + char counter.
 *
 * Auto-grows up to a soft cap (~6 lines visible); overflow scrolls.
 * Counter turns warning at 90%, error at 100%.
 */
import { useEffect, useRef } from 'react';
import { PROMPT_MAX_CHARS } from '@/data/image-models';

interface Props {
    value: string;
    onChange: (next: string) => void;
    disabled?: boolean;
    placeholder?: string;
}

export function PromptInput({ value, onChange, disabled = false, placeholder = '描述你想要的图像...' }: Props) {
    const ref = useRef<HTMLTextAreaElement | null>(null);

    // Auto-resize: keep textarea height equal to scrollHeight up to the
    // 6-row visual cap (`maxHeight: 9.6rem` = 6 lines × 1.6rem).
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }, [value]);

    const len = value.length;
    const overLimit = len > PROMPT_MAX_CHARS;
    const warn = len > PROMPT_MAX_CHARS * 0.9;

    return (
        <div className="relative w-full">
            <label htmlFor="image-prompt" className="sr-only">
                生成 prompt
            </label>
            <textarea
                ref={ref}
                id="image-prompt"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                rows={3}
                aria-invalid={overLimit}
                aria-describedby="image-prompt-counter"
                className={[
                    'w-full px-4 py-3 pr-20 rounded-xl resize-none',
                    'bg-surface border shadow-card',
                    'text-sm text-navy placeholder:text-minor-ink leading-relaxed',
                    'transition-colors duration-150 ease-brand',
                    'focus:outline-none focus:ring-0',
                    overLimit
                        ? 'border-status-error-border focus:border-status-error-border'
                        : 'border-brand-border focus:border-brand-accent',
                    disabled ? 'opacity-60 cursor-not-allowed' : '',
                ].join(' ')}
                style={{ minHeight: '4.8rem', maxHeight: '9.6rem' }}
            />
            <span
                id="image-prompt-counter"
                aria-live="polite"
                className={[
                    'absolute right-3 bottom-2 text-[11px] tabular-nums',
                    overLimit ? 'text-status-error-text' : warn ? 'text-brand-accent' : 'text-minor-ink',
                ].join(' ')}
            >
                {len}/{PROMPT_MAX_CHARS}
            </span>
        </div>
    );
}

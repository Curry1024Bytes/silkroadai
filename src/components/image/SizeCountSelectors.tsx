'use client';

/**
 * SizeSelector + CountSelector (PR-T2) — sibling button-groups.
 *
 * Co-located in one file because they share the exact same shape (an
 * a11y-correct radio-style button group with active/idle styles) and
 * stay visually adjacent in the studio layout.
 */
import { IMAGE_COUNT_OPTIONS, IMAGE_SIZE_OPTIONS } from '@/data/image-models';

interface SizeProps {
    value: string;
    onChange: (id: string) => void;
    disabled?: boolean;
}

export function SizeSelector({ value, onChange, disabled = false }: SizeProps) {
    return (
        <div role="radiogroup" aria-label="图像尺寸" className="inline-flex flex-wrap gap-1.5">
            {IMAGE_SIZE_OPTIONS.map((s) => {
                const active = s.id === value;
                return (
                    <button
                        key={s.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={disabled}
                        onClick={() => onChange(s.id)}
                        className={[
                            'px-3 py-2 rounded-lg text-xs leading-tight cursor-pointer',
                            'transition-colors duration-150 ease-brand',
                            'border min-h-[44px]',
                            active
                                ? 'border-brand-accent bg-paper-muted text-navy font-medium'
                                : 'border-brand-border bg-surface text-muted-ink hover:border-brand-accent/60',
                            disabled ? 'opacity-60 cursor-not-allowed' : '',
                        ].join(' ')}
                    >
                        <span className="block">{s.label}</span>
                        <span className="block text-[10px] text-minor-ink mt-0.5 tabular-nums">{s.sub}</span>
                    </button>
                );
            })}
        </div>
    );
}

interface CountProps {
    value: number;
    onChange: (n: number) => void;
    disabled?: boolean;
}

export function CountSelector({ value, onChange, disabled = false }: CountProps) {
    return (
        <div role="radiogroup" aria-label="生成张数" className="inline-flex gap-1.5">
            {IMAGE_COUNT_OPTIONS.map((n) => {
                const active = n === value;
                return (
                    <button
                        key={n}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={disabled}
                        onClick={() => onChange(n)}
                        className={[
                            'w-11 h-11 rounded-lg text-sm font-medium tabular-nums cursor-pointer',
                            'transition-colors duration-150 ease-brand',
                            'border',
                            active
                                ? 'border-brand-accent bg-paper-muted text-navy'
                                : 'border-brand-border bg-surface text-muted-ink hover:border-brand-accent/60',
                            disabled ? 'opacity-60 cursor-not-allowed' : '',
                        ].join(' ')}
                    >
                        {n}
                    </button>
                );
            })}
        </div>
    );
}

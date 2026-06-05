'use client';

/**
 * ModelSelector (PR-T2 → W8 D7 重构,2026-05-26).
 *
 * Dropdown of image models, **grouped by vendor**:
 *   1. OpenAI(国外旗舰)
 *   2. Google(国外)
 *   3. 国内厂商(SiliconFlow / Other,当前为空,占位以备扩展)
 *
 * 国外厂商前排展示(operator decision 2026-05-26)。每行:label + blurb
 * + ¥ 价格 + 可选 badge(推荐 / 旗舰)。
 */
import { useState, useRef, useEffect } from 'react';
import { IMAGE_MODEL_OPTIONS, type ImageModelOption, type ImageVendor } from '@/data/image-models';

/** Vendor 分组顺序 — foreign 系前排,domestic 后排。 */
const VENDOR_ORDER: ImageVendor[] = ['OpenAI', 'Google', 'SiliconFlow', 'Other'];
const VENDOR_LABEL: Record<ImageVendor, string> = {
    OpenAI: 'OpenAI · 国外',
    Google: 'Google · 国外',
    SiliconFlow: 'SiliconFlow · 国内',
    Other: '其它',
};

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
                        'overflow-hidden list-none p-0 m-0 max-h-[480px] overflow-y-auto',
                    ].join(' ')}
                >
                    {VENDOR_ORDER.flatMap((vendor) => {
                        const items = IMAGE_MODEL_OPTIONS.filter((m) => m.vendor === vendor);
                        if (items.length === 0) return [];
                        return [
                            <li
                                key={`__hdr_${vendor}`}
                                aria-hidden="true"
                                className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-ink bg-paper-muted/40 border-b border-brand-border"
                            >
                                {VENDOR_LABEL[vendor]}
                            </li>,
                            ...items.map((m) => {
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
                            }),
                        ];
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

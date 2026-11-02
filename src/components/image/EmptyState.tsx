'use client';

/**
 * Empty placeholder shown when the studio has no current generation
 * result and history is also empty (or collapsed). Picks one of the
 * sample prompts on click → fills the prompt input.
 */
import { samplePrompts } from '@/data/image-models';
import { useLocale, useMessages } from '@/lib/i18n/client';
import { imageMessages } from '@/lib/i18n/messages/image';

interface Props {
    onPickSample: (prompt: string) => void;
}

export function ImageEmptyState({ onPickSample }: Props) {
    const m = useMessages(imageMessages).empty;
    const prompts = samplePrompts(useLocale());
    return (
        <div
            role="region"
            aria-label={m.aria}
            className={[
                'flex flex-col items-center justify-center gap-5',
                'min-h-[280px] sm:min-h-[420px]',
                'rounded-xl bg-paper-muted border border-dashed border-brand-border',
                'px-6 py-12 text-center',
            ].join(' ')}
        >
            <div aria-hidden="true" className="text-5xl" style={{ filter: 'grayscale(0.2)' }}>
                🎨
            </div>
            <div>
                <h2 className="m-0 text-lg font-semibold text-navy">{m.headline}</h2>
                <p className="m-0 mt-1.5 text-sm text-muted-ink">{m.sub}</p>
            </div>
            <ul className="list-none p-0 m-0 grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-2xl">
                {prompts.map((p) => (
                    <li key={p}>
                        <button
                            type="button"
                            onClick={() => onPickSample(p)}
                            className={[
                                'w-full text-left px-3.5 py-2.5 rounded-lg cursor-pointer',
                                'bg-surface border border-brand-border',
                                'text-xs text-muted-ink leading-relaxed',
                                'transition-colors duration-150 ease-brand',
                                'hover:border-brand-accent hover:text-navy',
                            ].join(' ')}
                        >
                            {p}
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

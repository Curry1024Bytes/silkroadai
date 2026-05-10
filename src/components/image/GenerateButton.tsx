'use client';

/**
 * GenerateButton (PR-T2) — large brand-accent submit CTA.
 *
 * States:
 *   default  → "生成 →"          enabled, brand-accent solid
 *   loading  → "生成中..."        disabled, spinner
 *   error    → "重试"             enabled, navy outline + small error msg
 *   disabled → "生成 →"           disabled (prompt empty / over limit /
 *                                 余额不足 / etc.)
 */
import { Button } from '@/components/ui/Button';

export type GenerateButtonState = 'idle' | 'loading' | 'error';

interface Props {
    state: GenerateButtonState;
    disabled?: boolean;
    onClick: () => void;
    errorMessage?: string;
    /** Optional one-line hint shown only while `state === 'loading'`.
     *  PR-T2 504 fix: surfaces "约需 30-60 秒" for slow models (gpt-image-2)
     *  so customers don't think the studio is frozen. */
    slowModelHint?: string;
}

export function GenerateButton({ state, disabled = false, onClick, errorMessage, slowModelHint }: Props) {
    const isLoading = state === 'loading';
    const isError = state === 'error';

    return (
        <div className="flex flex-col items-end gap-1.5">
            <Button
                type="button"
                variant={isError ? 'secondary' : 'primary'}
                size="lg"
                onClick={onClick}
                loading={isLoading}
                disabled={disabled || isLoading}
                aria-label="生成图像"
                className="min-w-[140px]"
            >
                {isLoading ? '生成中…' : isError ? '重试' : '生成 →'}
            </Button>
            {isError && errorMessage ? (
                <span role="alert" className="text-xs text-status-error-text max-w-[260px] text-right">
                    {errorMessage}
                </span>
            ) : null}
            {isLoading && slowModelHint ? (
                <span aria-live="polite" className="text-xs text-minor-ink max-w-[260px] text-right">
                    {slowModelHint}
                </span>
            ) : null}
        </div>
    );
}

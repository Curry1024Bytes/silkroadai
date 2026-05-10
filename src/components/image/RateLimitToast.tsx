'use client';

/**
 * Friendly rate-limit toast (PR-T3 Item 1).
 *
 * Shown at the top of the studio when generate returns 429. Displays
 * a live countdown until the bucket frees up; auto-dismisses (via
 * `onExpire`) when the countdown reaches 0 so the studio re-enables
 * the GenerateButton.
 *
 * Self-contained timer — caller passes `retryAfterMs` once and the
 * toast manages its own decrementing state. If `retryAfterMs` ≤ 0
 * on mount, fires `onExpire` immediately.
 */
import { useEffect, useState } from 'react';

interface Props {
    /** ms until rate-limit window frees. */
    retryAfterMs: number;
    /** Called once when the countdown reaches 0. Studio uses this to
     *  re-enable the GenerateButton. */
    onExpire: () => void;
    /** Manual dismiss (X button). Optional — default = caller manages. */
    onDismiss?: () => void;
}

export function RateLimitToast({ retryAfterMs, onExpire, onDismiss }: Props) {
    const initialSec = Math.max(0, Math.ceil(retryAfterMs / 1000));
    const [secLeft, setSecLeft] = useState(initialSec);

    useEffect(() => {
        if (secLeft <= 0) {
            onExpire();
            return;
        }
        const t = setTimeout(() => setSecLeft((n) => n - 1), 1000);
        return () => clearTimeout(t);
    }, [secLeft, onExpire]);

    return (
        <div
            role="status"
            aria-live="polite"
            className={[
                'rounded-xl px-4 py-3',
                'bg-status-warning-bg border border-status-warning-border',
                'flex items-center gap-3',
                'text-sm text-status-warning-text',
            ].join(' ')}
        >
            <span aria-hidden="true" className="text-base shrink-0">
                ⏳
            </span>
            <span className="flex-1">
                您 1 分钟内生成次数已达上限(10 次),请稍候 <strong className="tabular-nums">{secLeft}</strong> 秒再试
            </span>
            {onDismiss && (
                <button
                    type="button"
                    onClick={onDismiss}
                    aria-label="关闭"
                    className="w-7 h-7 flex items-center justify-center rounded cursor-pointer text-status-warning-text/70 hover:text-status-warning-text"
                >
                    ✕
                </button>
            )}
        </div>
    );
}

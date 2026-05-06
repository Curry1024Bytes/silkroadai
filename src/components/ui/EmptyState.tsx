/**
 * EmptyState — design-system primitive.
 *
 * Centered placeholder for zero-data screens: "尚未创建 API key", "暂无消费
 * 记录", "本周期无调用". Replaces the W6-era pattern of a bare paragraph
 * which read as a UI bug rather than an intentional empty state.
 *
 * Anatomy
 * -------
 *   <EmptyState>
 *     <EmptyState.Icon>     — optional emoji-free SVG (~32px)
 *     <EmptyState.Title>    — short headline ("还没有 API key")
 *     <EmptyState.Body>     — one-sentence why ("创建第一个 key 即可调用…")
 *     <EmptyState.Action>   — primary CTA (Button or Link)
 *
 * Sized to fit comfortably inside a Card. Override `className` for narrower
 * surfaces (e.g. inside a sidebar widget).
 */
import * as React from 'react';

export interface EmptyStateProps {
    /** Optional SVG icon. Render at ~32×32; component centers + spaces it. */
    icon?: React.ReactNode;
    title: string;
    body?: React.ReactNode;
    /** Single action node (e.g. <Button>). Pass a fragment for multiple. */
    action?: React.ReactNode;
    className?: string;
}

export function EmptyState({
    icon,
    title,
    body,
    action,
    className,
}: EmptyStateProps): React.ReactElement {
    return (
        <div
            className={[
                'flex flex-col items-center justify-center text-center px-6 py-12 gap-3',
                className ?? '',
            ]
                .filter(Boolean)
                .join(' ')}
        >
            {icon ? (
                <div className="text-minor-ink mb-1" aria-hidden="true">
                    {icon}
                </div>
            ) : null}
            <h3 className="text-lg font-semibold text-navy m-0">{title}</h3>
            {body ? (
                <p className="text-sm text-muted-ink m-0 max-w-sm leading-relaxed">{body}</p>
            ) : null}
            {action ? <div className="mt-2">{action}</div> : null}
        </div>
    );
}

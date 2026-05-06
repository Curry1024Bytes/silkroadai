/**
 * FormError — design-system primitive.
 *
 * Two flavors:
 *   <FormError>          inline message under a single Input (sm, red text)
 *   <FormError severity="banner">  full-row alert at the top of a form
 *
 * Renders nothing when `children` is falsy — safe to leave in the JSX even
 * when there's no error to show. ARIA: `role="alert"` so the message is
 * announced when it appears.
 */
import * as React from 'react';

export type FormErrorSeverity = 'inline' | 'banner';

export interface FormErrorProps {
    severity?: FormErrorSeverity;
    /** Plain string OR rich content (e.g. error + retry button). */
    children?: React.ReactNode;
    className?: string;
}

const INLINE =
    'text-sm text-status-error-text mt-1.5 leading-snug';

const BANNER =
    'text-sm rounded-lg px-4 py-3 ' +
    'bg-status-error-bg border border-status-error-border text-status-error-text ' +
    'flex items-start gap-2';

export function FormError({
    severity = 'inline',
    children,
    className,
}: FormErrorProps): React.ReactElement | null {
    if (children === undefined || children === null || children === false || children === '') {
        return null;
    }
    return (
        <div
            role="alert"
            className={[
                severity === 'banner' ? BANNER : INLINE,
                className ?? '',
            ]
                .filter(Boolean)
                .join(' ')}
        >
            {children}
        </div>
    );
}

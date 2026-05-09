/**
 * Label — design-system primitive.
 *
 * Semantic <label> element. Always associate with an input via `htmlFor` —
 * required for screen readers and for click-to-focus behavior.
 *
 * `required` shows a small red asterisk after the label text. The actual
 * native HTML5 validation is the caller's responsibility (set `required`
 * on the Input separately).
 */
import * as React from 'react';

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
    required?: boolean;
}

export function Label({ required, className, children, ...rest }: LabelProps): React.ReactElement {
    return (
        <label
            {...rest}
            className={['text-sm font-medium text-muted-ink mb-1.5 block', className ?? ''].filter(Boolean).join(' ')}
        >
            {children}
            {required ? (
                <span className="text-status-error-text ml-0.5" aria-hidden="true">
                    *
                </span>
            ) : null}
        </label>
    );
}

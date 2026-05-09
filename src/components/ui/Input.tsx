/**
 * Input — design-system primitive.
 *
 * White surface, brand-border, focused-state navy ring. Wraps the native
 * `<input>` directly so all standard props (type, value, onChange, name,
 * required, autoComplete, …) are passed through untouched.
 *
 * `error` prop swaps the border for a status-error tint and adds a red ring
 * on focus. The matching error message belongs in a sibling <FormError>
 * component — Input itself does not render the message text so callers
 * have control over layout (inline vs below).
 */
import * as React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
    /** Visual error state. The error MESSAGE belongs in a sibling
     *  <FormError>; this only changes the border + focus ring. */
    error?: boolean;
    /** Render full-width within the parent. Default true (forms wrap each
     *  input in a labeled row, so block is the common case). */
    block?: boolean;
}

const BASE_CLASSES =
    'h-10 px-3.5 text-[15px] text-ink rounded-lg border bg-surface ' +
    'placeholder:text-minor-ink ' +
    'transition-shadow duration-150 ease-brand outline-none ' +
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-paper-muted';

const STATE_OK = 'border-brand-border ' + 'hover:border-muted-ink/40 ' + 'focus:border-navy focus:shadow-focus';

const STATE_ERR =
    'border-status-error-border ' + 'focus:border-status-error-text ' + 'focus:shadow-[0_0_0_3px_rgba(185,28,28,0.18)]';

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
    { error, block = true, className, type = 'text', ...rest },
    ref,
) {
    return (
        <input
            ref={ref}
            type={type}
            aria-invalid={error || undefined}
            {...rest}
            className={[BASE_CLASSES, error ? STATE_ERR : STATE_OK, block ? 'w-full' : '', className ?? '']
                .filter(Boolean)
                .join(' ')}
        />
    );
});

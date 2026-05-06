/**
 * Button — design-system primitive.
 *
 * Variants
 * --------
 *   primary   — filled navy on paper. The single highest-emphasis action
 *               on a screen (e.g. "立即开始 →" / "充值"). Use one per view.
 *   secondary — navy outline on paper. Co-equal with primary when actions
 *               truly are at the same priority (e.g. "保存" / "取消").
 *   ghost     — text-only with hover background. Tertiary affordance —
 *               nav links, "返回登录", inline edit.
 *   danger    — filled status-error. Destructive actions only ("撤销 key",
 *               "永久删除"). Sparingly.
 *
 * Sizes
 * -----
 *   sm  — 32px tall, 14px text
 *   md  — 40px tall, 15px text (default — matches landing's CTA size)
 *   lg  — 48px tall, 16px text (rare; hero-section CTAs)
 *
 * Loading vs disabled
 * -------------------
 * `loading=true` shows a spinner and disables the button without changing
 * width (avoids layout shift). `disabled=true` greys it out without a
 * spinner. Both block clicks at the DOM level.
 *
 * Renders <button> by default; pass `href` to render <a> for navigation
 * styled identically. Don't render <Link> here — the caller wraps the
 * Button in <Link> if Next routing is needed.
 */
import * as React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface BaseProps {
    variant?: ButtonVariant;
    size?: ButtonSize;
    loading?: boolean;
    /** Render full-width within the parent (block instead of inline-block). */
    block?: boolean;
    children: React.ReactNode;
    className?: string;
}

type ButtonAsButton = BaseProps &
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, keyof BaseProps> & {
        href?: undefined;
    };

type ButtonAsAnchor = BaseProps &
    Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof BaseProps> & {
        href: string;
    };

export type ButtonProps = ButtonAsButton | ButtonAsAnchor;

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
    primary:
        'bg-navy text-paper hover:bg-navy-strong border border-navy ' +
        'shadow-card focus-visible:ring-2 focus-visible:ring-navy/30',
    secondary:
        'bg-paper text-navy border border-navy hover:bg-paper-muted ' +
        'focus-visible:ring-2 focus-visible:ring-navy/30',
    ghost:
        'bg-transparent text-muted-ink hover:bg-paper-muted hover:text-navy ' +
        'border border-transparent focus-visible:ring-2 focus-visible:ring-navy/30',
    danger:
        'bg-status-error-text text-paper border border-status-error-text ' +
        'hover:opacity-90 focus-visible:ring-2 focus-visible:ring-status-error-text/30',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
    sm: 'h-8 px-3 text-sm',
    md: 'h-10 px-5 text-[15px]',
    lg: 'h-12 px-6 text-base',
};

const BASE_CLASSES =
    'inline-flex items-center justify-center gap-2 rounded-lg font-medium ' +
    'transition-colors duration-150 ease-brand outline-none ' +
    'disabled:opacity-50 disabled:cursor-not-allowed ' +
    'select-none whitespace-nowrap no-underline';

function compose({
    variant = 'primary',
    size = 'md',
    block,
    className,
}: {
    variant?: ButtonVariant;
    size?: ButtonSize;
    block?: boolean;
    className?: string;
}): string {
    return [
        BASE_CLASSES,
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        block ? 'w-full' : '',
        className ?? '',
    ]
        .filter(Boolean)
        .join(' ');
}

function Spinner({ size }: { size: ButtonSize }) {
    const px = size === 'sm' ? 14 : size === 'md' ? 16 : 18;
    return (
        <svg
            width={px}
            height={px}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="animate-spin"
        >
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
            <path
                d="M22 12a10 10 0 0 1-10 10"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
            />
        </svg>
    );
}

export function Button(props: ButtonProps): React.ReactElement {
    const {
        variant = 'primary',
        size = 'md',
        loading = false,
        block,
        children,
        className,
        ...rest
    } = props;

    const classes = compose({ variant, size, block, className });

    if ('href' in rest && rest.href !== undefined) {
        const anchorRest = rest as React.AnchorHTMLAttributes<HTMLAnchorElement>;
        return (
            <a
                {...anchorRest}
                aria-disabled={loading || anchorRest['aria-disabled']}
                className={classes}
            >
                {loading ? <Spinner size={size} /> : null}
                {children}
            </a>
        );
    }

    const buttonRest = rest as React.ButtonHTMLAttributes<HTMLButtonElement>;
    return (
        <button
            type={buttonRest.type ?? 'button'}
            {...buttonRest}
            disabled={loading || buttonRest.disabled}
            className={classes}
        >
            {loading ? <Spinner size={size} /> : null}
            {children}
        </button>
    );
}

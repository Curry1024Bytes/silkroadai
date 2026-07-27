/**
 * Card — design-system primitive.
 *
 * The single content surface used across portal pages: dashboard cards,
 * /balance summary, /keys list rows, /usage tables. White background on
 * paper, brand-border, rounded-xl (12px), subtle warm shadow.
 *
 * Variants
 * --------
 *   default — white surface, brand-border, shadow-card
 *   muted   — paper-muted surface (for nested / secondary cards inside a
 *             default card; e.g. step blocks on landing's "How it works")
 *   inset   — borderless / shadowless / no padding (for grouping content
 *             inside a parent card without visually nesting)
 *
 * Anatomy
 * -------
 *   <Card>
 *     <CardHeader>   — optional, padded, smaller text-muted-ink eyebrow
 *     <CardTitle>    — h2/h3 sized title (consumer chooses the heading level)
 *     <CardContent>  — main content slot
 *     <CardFooter>   — actions / metadata, separated by a top-border
 *
 * Padding is handled at slot level (header / content / footer), so a Card
 * with no slots sits flush — useful for tables that already manage their
 * own padding.
 */
import * as React from 'react';

export type CardVariant = 'default' | 'muted' | 'inset';

const VARIANT_CLASSES: Record<CardVariant, string> = {
    default: 'bg-surface border border-brand-border shadow-card rounded-lg',
    muted: 'bg-paper-muted border border-transparent rounded-lg',
    inset: 'bg-transparent border-0 rounded-none',
};

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
    variant?: CardVariant;
    /** Render-as different element (article/section/etc.). Default div. */
    as?: keyof React.JSX.IntrinsicElements;
}

export function Card({ variant = 'default', as = 'div', className, children, ...rest }: CardProps): React.ReactElement {
    const Tag = as as React.ElementType;
    return (
        <Tag {...rest} className={[VARIANT_CLASSES[variant], className ?? ''].filter(Boolean).join(' ')}>
            {children}
        </Tag>
    );
}

export function CardHeader({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
    return (
        <div
            {...rest}
            className={['px-6 pt-5 pb-3 flex items-start justify-between gap-3', className ?? '']
                .filter(Boolean)
                .join(' ')}
        >
            {children}
        </div>
    );
}

export function CardTitle({
    as = 'h2',
    className,
    children,
    ...rest
}: React.HTMLAttributes<HTMLHeadingElement> & {
    as?: 'h1' | 'h2' | 'h3' | 'h4';
}): React.ReactElement {
    const Tag = as as React.ElementType;
    return (
        <Tag
            {...rest}
            className={['font-display text-lg font-semibold text-navy', className ?? ''].filter(Boolean).join(' ')}
        >
            {children}
        </Tag>
    );
}

export function CardContent({
    className,
    children,
    ...rest
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
    return (
        <div {...rest} className={['px-6 py-4 text-muted-ink', className ?? ''].filter(Boolean).join(' ')}>
            {children}
        </div>
    );
}

export function CardFooter({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
    return (
        <div
            {...rest}
            className={['px-6 py-3 border-t border-brand-border flex items-center justify-end gap-3', className ?? '']
                .filter(Boolean)
                .join(' ')}
        >
            {children}
        </div>
    );
}

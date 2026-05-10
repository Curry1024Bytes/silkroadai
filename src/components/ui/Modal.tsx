'use client';

/**
 * Modal — design-system primitive (PR-T3).
 *
 * Generic centered modal with backdrop + ESC-to-close + focus management.
 * Used by /image's BalanceShortfallModal / ContentFilterModal /
 * LargeCostConfirmModal. NOT used by ImageModal — that one is a
 * full-screen image viewer with its own gesture model.
 *
 * Slots:
 *   <Modal open onClose={...} title="..." footer={...}>
 *     <p>body...</p>
 *   </Modal>
 *
 * Dismissibility:
 *   - Click backdrop → onClose
 *   - ESC → onClose
 *   - The X button in the corner is shown when `dismissible !== false`
 *     (default true). Confirm flows that demand explicit choice should
 *     pass `dismissible={false}` so the only escape is via the footer
 *     buttons.
 */
import { useEffect, useRef } from 'react';

interface Props {
    open: boolean;
    onClose: () => void;
    /** h2 title at top. */
    title: string;
    /** Footer slot — typically Button(s). Aligned right. */
    footer?: React.ReactNode;
    /** Show the X dismiss button + allow ESC / backdrop close. Default true. */
    dismissible?: boolean;
    /** Optional icon shown next to the title. Emoji or small SVG. */
    icon?: React.ReactNode;
    children: React.ReactNode;
}

export function Modal({ open, onClose, title, footer, dismissible = true, icon, children }: Props) {
    const dialogRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open || !dismissible) return;
        function onKey(e: KeyboardEvent) {
            if (e.key === 'Escape') onClose();
        }
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, dismissible, onClose]);

    useEffect(() => {
        if (open && dialogRef.current) {
            dialogRef.current.focus();
        }
    }, [open]);

    if (!open) return null;

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            ref={dialogRef}
            tabIndex={-1}
            onClick={dismissible ? onClose : undefined}
            className={[
                'fixed inset-0 z-50',
                'bg-navy-strong/70 backdrop-blur-sm',
                'flex items-center justify-center p-4 sm:p-8',
            ].join(' ')}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                className={[
                    'relative w-full max-w-md',
                    'bg-surface rounded-xl shadow-card-strong',
                    'flex flex-col',
                ].join(' ')}
            >
                <header className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
                    <h2 className="m-0 text-base font-semibold text-navy flex items-center gap-2">
                        {icon ? (
                            <span aria-hidden="true" className="shrink-0">
                                {icon}
                            </span>
                        ) : null}
                        <span>{title}</span>
                    </h2>
                    {dismissible && (
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="关闭"
                            className="w-8 h-8 flex items-center justify-center rounded cursor-pointer text-muted-ink hover:text-navy hover:bg-paper-muted"
                        >
                            ✕
                        </button>
                    )}
                </header>
                <div className="px-5 pb-5 text-sm text-ink leading-relaxed">{children}</div>
                {footer ? (
                    <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-brand-border">
                        {footer}
                    </footer>
                ) : null}
            </div>
        </div>
    );
}

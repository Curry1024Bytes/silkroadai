import type { TicketStatus } from '@prisma/client';

const STYLES: Record<TicketStatus, string> = {
    open: 'bg-status-info-bg border-status-info-border text-status-info-text',
    waiting_customer: 'bg-status-warning-bg border-status-warning-border text-status-warning-text',
    resolved: 'bg-status-success-bg border-status-success-border text-status-success-text',
    closed: 'bg-paper-muted border-brand-border text-minor-ink',
};

/** 同步纯展示组件(server / client 都能用);label 由调用方按 locale 传入。 */
export function TicketStatusBadge({ status, label }: { status: TicketStatus; label: string }) {
    return (
        <span
            data-status={status}
            className={[
                'inline-block whitespace-nowrap rounded border px-2 py-0.5 text-xs font-medium',
                STYLES[status],
            ].join(' ')}
        >
            {label}
        </span>
    );
}

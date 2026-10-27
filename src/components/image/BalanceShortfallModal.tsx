'use client';

/**
 * Insufficient balance modal (PR-T3 Item 2).
 *
 * Triggered when /api/portal/image/generate returns 402 (or 403 with
 * upstream code `insufficient_user_quota`). The CostPreview already
 * gates this client-side via SWR balance fetching; this modal is the
 * server-side fallback for races (balance dropped between preview +
 * submit) or upstream timing.
 */
import Link from 'next/link';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useMessages } from '@/lib/i18n/client';
import { imageMessages } from '@/lib/i18n/messages/image';

interface Props {
    open: boolean;
    onClose: () => void;
    /** What this generation was estimated to cost (CNY). */
    requiredCny: number;
    /** Customer's current balance (CNY). May be undefined if quota
     *  endpoint failed; then we just say "余额不足" without numbers. */
    remainCny?: number;
}

export function BalanceShortfallModal({ open, onClose, requiredCny, remainCny }: Props) {
    const m = useMessages(imageMessages).balanceModal;
    return (
        <Modal
            open={open}
            onClose={onClose}
            title={m.title}
            icon="💰"
            footer={
                <>
                    <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                        {m.cancel}
                    </Button>
                    <Link
                        href="/pay"
                        className={[
                            'inline-flex items-center justify-center cursor-pointer no-underline',
                            'px-4 h-10 text-sm font-medium rounded-lg',
                            'bg-navy text-paper hover:bg-navy-strong',
                            'transition-colors duration-150 ease-brand',
                        ].join(' ')}
                    >
                        {m.topUp}
                    </Link>
                </>
            }
        >
            <p className="m-0">{m.body}</p>
            <p className="m-0 mt-2 text-muted-ink">
                {m.costPrefix}
                <strong className="text-navy">¥{requiredCny.toFixed(2)}</strong>
                {typeof remainCny === 'number' ? (
                    <>
                        {m.balanceMid}
                        <strong className="text-navy">¥{remainCny.toFixed(2)}</strong>
                        {m.end}
                    </>
                ) : (
                    m.end
                )}
            </p>
            <p className="m-0 mt-2 text-muted-ink text-xs">{m.note}</p>
        </Modal>
    );
}

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
    return (
        <Modal
            open={open}
            onClose={onClose}
            title="余额不足"
            icon="💰"
            footer={
                <>
                    <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                        取消
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
                        立即充值 →
                    </Link>
                </>
            }
        >
            <p className="m-0">余额不足以生成此次。</p>
            <p className="m-0 mt-2 text-muted-ink">
                本次约消耗 <strong className="text-navy">¥{requiredCny.toFixed(2)}</strong>
                {typeof remainCny === 'number' ? (
                    <>
                        ,当前余额 <strong className="text-navy">¥{remainCny.toFixed(2)}</strong>。
                    </>
                ) : (
                    '。'
                )}
            </p>
            <p className="m-0 mt-2 text-muted-ink text-xs">充值后立即可用,余额永不失效。</p>
        </Modal>
    );
}

'use client';

/**
 * Large-cost confirmation modal (PR-T3 Item 4).
 *
 * When estimated cost > ¥5 (e.g. nano-banana-pro × 4 张 = ¥5.76),
 * intercept the [生成] click + show a confirm. Sub-¥5 generations
 * skip this gate so the dominant low-cost flow stays one-click.
 *
 * Threshold + "are you sure" copy lifted from the brief; threshold
 * lives in the studio orchestrator as a const so a future PR can tune.
 */
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useMessages } from '@/lib/i18n/client';
import { imageMessages } from '@/lib/i18n/messages/image';

interface Props {
    open: boolean;
    onCancel: () => void;
    onConfirm: () => void;
    costCny: number;
    /** Customer's current balance (CNY); undefined if quota endpoint fails. */
    remainCny?: number;
}

export function LargeCostConfirmModal({ open, onCancel, onConfirm, costCny, remainCny }: Props) {
    const m = useMessages(imageMessages).largeCost;
    return (
        <Modal
            open={open}
            onClose={onCancel}
            title={m.title}
            icon="💸"
            dismissible={false}
            footer={
                <>
                    <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                        {m.cancel}
                    </Button>
                    <Button type="button" variant="primary" size="sm" onClick={onConfirm}>
                        {m.confirm}
                    </Button>
                </>
            }
        >
            <p className="m-0">
                {m.willSpend}
                <strong className="text-navy">¥{costCny.toFixed(2)}</strong>
                {typeof remainCny === 'number' ? (
                    <>
                        {m.balanceOpen}
                        <span className="text-muted-ink">¥{remainCny.toFixed(2)}</span>
                        {m.balanceClose}
                    </>
                ) : null}
                {m.end}
            </p>
            <p className="m-0 mt-2 text-muted-ink text-xs">{m.explainer}</p>
        </Modal>
    );
}

'use client';

/**
 * Content-filter rejection modal (PR-T3 Item 3).
 *
 * Shown when the generate endpoint returns 400 with `error: 'content_filter'`.
 * Backend detects this from upstream OpenAI / Google rejections (codes:
 * content_policy_violation / safety_filter_triggered / etc, OR Gemini's
 * 200-with-empty-content pattern that means safety filter).
 *
 * Avoids leaking raw upstream error message (sometimes contains 3rd-party
 * brand names or internal codes that confuse customers). The friendly
 * copy below covers the most common rejection categories.
 */
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useMessages } from '@/lib/i18n/client';
import { imageMessages } from '@/lib/i18n/messages/image';

interface Props {
    open: boolean;
    onClose: () => void;
}

export function ContentFilterModal({ open, onClose }: Props) {
    const m = useMessages(imageMessages).contentFilter;
    return (
        <Modal
            open={open}
            onClose={onClose}
            title={m.title}
            icon="🛡️"
            footer={
                <Button type="button" variant="primary" size="sm" onClick={onClose}>
                    {m.ok}
                </Button>
            }
        >
            <p className="m-0">{m.body}</p>
            <p className="m-0 mt-3 text-muted-ink">{m.adjust}</p>
            <ul className="mt-1.5 mb-0 pl-5 text-muted-ink text-xs leading-relaxed">
                {m.items.map((item) => (
                    <li key={item}>{item}</li>
                ))}
            </ul>
            <p className="m-0 mt-3 text-status-success-text text-xs">{m.noCharge}</p>
        </Modal>
    );
}

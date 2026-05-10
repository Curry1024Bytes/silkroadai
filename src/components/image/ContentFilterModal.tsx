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

interface Props {
    open: boolean;
    onClose: () => void;
}

export function ContentFilterModal({ open, onClose }: Props) {
    return (
        <Modal
            open={open}
            onClose={onClose}
            title="内容审核未通过"
            icon="🛡️"
            footer={
                <Button type="button" variant="primary" size="sm" onClick={onClose}>
                    我知道了
                </Button>
            }
        >
            <p className="m-0">您的提示词触发了内容审核,本次生成已取消。</p>
            <p className="m-0 mt-3 text-muted-ink">请调整提示词,避免:</p>
            <ul className="mt-1.5 mb-0 pl-5 text-muted-ink text-xs leading-relaxed">
                <li>暴力 / 恐怖 / 血腥相关描述</li>
                <li>色情 / 裸露 / 性暗示内容</li>
                <li>真人脸 / 名人模仿 / 头像合成</li>
                <li>政治敏感 / 仇恨言论</li>
            </ul>
            <p className="m-0 mt-3 text-status-success-text text-xs">本次未扣费。</p>
        </Modal>
    );
}

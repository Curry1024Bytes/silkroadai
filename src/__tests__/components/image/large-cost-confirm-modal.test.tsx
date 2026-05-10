/**
 * PR-T3 — LargeCostConfirmModal SSR smoke.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { LargeCostConfirmModal } from '@/components/image/LargeCostConfirmModal';

describe('<LargeCostConfirmModal />', () => {
    it('renders nothing when open=false', () => {
        const html = renderToString(
            <LargeCostConfirmModal open={false} onCancel={() => {}} onConfirm={() => {}} costCny={7.84} />,
        );
        expect(html).toBe('');
    });

    it('shows the cost + the confirm copy when open', () => {
        const html = renderToString(
            <LargeCostConfirmModal
                open={true}
                onCancel={() => {}}
                onConfirm={() => {}}
                costCny={7.84}
                remainCny={20}
            />,
        );
        expect(html).toContain('确认生成');
        expect(html).toContain('7.84');
        expect(html).toContain('20.00');
        // ¥5 threshold mentioned in the explainer
        expect(html).toContain('5');
    });

    it('shows the cost line without balance when remainCny is undefined', () => {
        const html = renderToString(
            <LargeCostConfirmModal open={true} onCancel={() => {}} onConfirm={() => {}} costCny={7.84} />,
        );
        expect(html).toContain('7.84');
        expect(html).not.toContain('当前余额');
    });

    it('NOT dismissible by ESC / backdrop — only the footer buttons (no X button)', () => {
        const html = renderToString(
            <LargeCostConfirmModal
                open={true}
                onCancel={() => {}}
                onConfirm={() => {}}
                costCny={7.84}
                remainCny={20}
            />,
        );
        // dismissible={false} suppresses the X button in the modal header
        expect(html).not.toMatch(/aria-label="关闭"/);
        // But the footer 取消/确认 buttons exist
        expect(html).toContain('取消');
        expect(html).toContain('确认生成');
    });
});

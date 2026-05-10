/**
 * PR-T3 — BalanceShortfallModal SSR smoke.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { BalanceShortfallModal } from '@/components/image/BalanceShortfallModal';

describe('<BalanceShortfallModal />', () => {
    it('renders nothing when open=false', () => {
        const html = renderToString(
            <BalanceShortfallModal open={false} onClose={() => {}} requiredCny={1.96} remainCny={0.5} />,
        );
        expect(html).toBe('');
    });

    it('shows the cost + remaining balance when open', () => {
        const html = renderToString(
            <BalanceShortfallModal open={true} onClose={() => {}} requiredCny={1.96} remainCny={0.5} />,
        );
        expect(html).toContain('余额不足');
        expect(html).toContain('1.96');
        expect(html).toContain('0.50');
    });

    it('omits the balance line when remainCny is undefined (quota fetch failed)', () => {
        const html = renderToString(<BalanceShortfallModal open={true} onClose={() => {}} requiredCny={1.96} />);
        expect(html).toContain('1.96');
        // The "当前余额" string lives behind the conditional — should
        // not render when remainCny is undefined.
        expect(html).not.toContain('当前余额');
    });

    it('CTA links to /pay', () => {
        const html = renderToString(
            <BalanceShortfallModal open={true} onClose={() => {}} requiredCny={1.96} remainCny={0.5} />,
        );
        expect(html).toMatch(/href="\/pay"/);
        expect(html).toContain('立即充值');
    });

    it('has role=dialog + aria-modal', () => {
        const html = renderToString(
            <BalanceShortfallModal open={true} onClose={() => {}} requiredCny={1.96} remainCny={0.5} />,
        );
        expect(html).toMatch(/role="dialog"/);
        expect(html).toMatch(/aria-modal="true"/);
    });
});

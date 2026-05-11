/**
 * PR-U2 — AgreementDisclosure SSR smoke.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { AgreementDisclosure, RESELLER_AGREEMENT_POINTS } from '@/components/reseller/AgreementDisclosure';

describe('<AgreementDisclosure />', () => {
    it('default-collapsed shows the toggle but not the agreement body', () => {
        const html = renderToString(<AgreementDisclosure />);
        expect(html).toContain('代理合作协议');
        expect(html).toContain('展开');
        // Items hidden when collapsed (initial SSR).
        expect(html).not.toContain('佣金计算:');
    });

    it('defaultOpen=true renders all 7 agreement points', () => {
        const html = renderToString(<AgreementDisclosure defaultOpen />);
        for (const p of RESELLER_AGREEMENT_POINTS) {
            expect(html).toContain(p.title);
        }
        expect(html).toContain('收起');
    });

    it('agreement points are immutable + 7 items (operator brief)', () => {
        expect(RESELLER_AGREEMENT_POINTS).toHaveLength(7);
        // Spot-check the critical numbers don't accidentally drift.
        const joined = RESELLER_AGREEMENT_POINTS.map((p) => p.body).join(' ');
        expect(joined).toContain('Bronze 10%');
        expect(joined).toContain('Silver 15%');
        expect(joined).toContain('Gold 20%');
        expect(joined).toContain('24 个月');
        expect(joined).toContain('14 天');
        expect(joined).toContain('¥100');
        expect(joined).toContain('7 个工作日');
    });
});

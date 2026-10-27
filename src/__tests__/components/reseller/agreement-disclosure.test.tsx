/**
 * PR-U2 — AgreementDisclosure SSR smoke.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { AgreementDisclosure, RESELLER_AGREEMENT_POINTS } from '@/components/reseller/AgreementDisclosure';
import { LocaleProvider } from '@/lib/i18n/client';
import { resellerMessages } from '@/lib/i18n/messages/reseller';

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

describe('<AgreementDisclosure /> (en)', () => {
    it('renders the English toggle + 7 translated points', () => {
        const html = renderToString(
            <LocaleProvider locale="en">
                <AgreementDisclosure defaultOpen />
            </LocaleProvider>,
        );
        expect(html).toContain('Silk Road AI Reseller Agreement');
        expect(html).toContain('Collapse');
        for (const p of resellerMessages.en.agreement.points) {
            // React escapes `&` in text nodes.
            expect(html).toContain(p.title.replace('&', '&amp;'));
        }
        expect(html).not.toContain('佣金计算');
        expect(html).not.toContain('展开');
    });

    it('English points keep the same count + critical numbers as the Chinese source', () => {
        const en = resellerMessages.en.agreement.points;
        expect(en).toHaveLength(RESELLER_AGREEMENT_POINTS.length);
        const joined = en.map((p) => p.body).join(' ');
        expect(joined).toContain('Bronze 10%');
        expect(joined).toContain('Silver 15%');
        expect(joined).toContain('Gold 20%');
        expect(joined).toContain('24 months');
        expect(joined).toContain('14 days');
        expect(joined).toContain('¥100');
        expect(joined).toContain('7 business days');
    });
});

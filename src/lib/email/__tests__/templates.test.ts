/**
 * W6 D2 — balanceAlertTemplate render smoke.
 *
 * Validates the template surface contract used by sendBalanceAlertEmail
 * + the email infrastructure (subject + text + html with same data).
 * No SMTP involved — pure string assertions on the rendered output.
 */
import { describe, expect, it } from 'vitest';
import { balanceAlertTemplate } from '@/lib/email/templates';

describe('balanceAlertTemplate (W6 D2)', () => {
    it('renders subject with current balance interpolated', () => {
        const c = balanceAlertTemplate({
            remainCny: 4.5,
            thresholdCny: 10,
            topupUrl: 'https://portal.silkroadai.io/pay',
            settingsUrl: 'https://portal.silkroadai.io/balance',
        });
        // 2-decimal CNY formatting in the subject (predictable for ops grep)
        expect(c.subject).toContain('Silk Road AI');
        expect(c.subject).toContain('¥4.50');
    });

    it('text body mentions threshold + remain + both URLs (so plain-text mail readers can act)', () => {
        const c = balanceAlertTemplate({
            remainCny: 2.13,
            thresholdCny: 20,
            topupUrl: 'https://portal.silkroadai.io/pay',
            settingsUrl: 'https://portal.silkroadai.io/balance',
        });
        expect(c.text).toContain('¥20.00');
        expect(c.text).toContain('¥2.13');
        expect(c.text).toContain('https://portal.silkroadai.io/pay');
        expect(c.text).toContain('https://portal.silkroadai.io/balance');
    });

    it('html body has the same data + the brand 立即充值 CTA + settings link', () => {
        const c = balanceAlertTemplate({
            remainCny: 0,
            thresholdCny: 10,
            topupUrl: 'https://portal.silkroadai.io/pay',
            settingsUrl: 'https://portal.silkroadai.io/balance',
        });
        expect(c.html).toContain('¥10.00');
        expect(c.html).toContain('¥0.00');
        // CTA button text + href
        expect(c.html).toMatch(/立即充值/);
        expect(c.html).toContain('href="https://portal.silkroadai.io/pay"');
        // Settings link to /balance
        expect(c.html).toContain('href="https://portal.silkroadai.io/balance"');
        // Brand color present
        expect(c.html).toContain('#0a1535');
    });
});

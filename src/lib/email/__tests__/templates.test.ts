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
        // W7 D4: brand navy is #1a2540 (was #0a1535 in W6 D2; the original
        // wasn't a design-system color, just a one-off). Both the body
        // text and the CTA button reference it inline.
        expect(c.html).toContain('#1a2540');
    });
});

describe('W7 D4 brand-shell consistency across all 3 templates', () => {
    /**
     * The shell unifies header / footer / CTA chrome so customers
     * recognize all three transactional mails as one family. These
     * assertions guard the contract — if a template is rewritten and
     * loses the contact pair / legal triplet / paper bg / brand-accent
     * accent, this test surfaces it before it ships.
     */
    const cases: Array<{ name: string; html: string }> = [];

    it('renders all 3 templates with the shared shell', async () => {
        const { emailVerificationTemplate, passwordResetTemplate, balanceAlertTemplate: bat } =
            await import('@/lib/email/templates');
        cases.push({
            name: 'verify-email',
            html: emailVerificationTemplate('https://silkroadai.io/verify-email?token=x', 24).html,
        });
        cases.push({
            name: 'reset-password',
            html: passwordResetTemplate('https://silkroadai.io/reset-password?token=y', 30).html,
        });
        cases.push({
            name: 'balance-alert',
            html: bat({
                remainCny: 4.5,
                thresholdCny: 10,
                topupUrl: 'https://silkroadai.io/pay',
                settingsUrl: 'https://silkroadai.io/balance',
            }).html,
        });
        for (const c of cases) {
            // Brand wordmark in the header strip
            expect(c.html, c.name).toContain('Silk Road AI');
            expect(c.html, c.name).toContain('Connecting Global Intelligence.');
            // Paper bg on body element
            expect(c.html, c.name).toMatch(/<body[^>]*background:#faf7f2/);
            // Header's brand-accent gold border-bottom (the 1px hairline
            // that ties the header to the landing's H2 underline aesthetic)
            expect(c.html, c.name).toContain('#c9a961');
            // Footer contact pair
            expect(c.html, c.name).toContain('Global_Ads');
            expect(c.html, c.name).toContain('support@silkroadai.io');
            // Footer legal triplet
            expect(c.html, c.name).toMatch(/href="https:\/\/silkroadai\.io\/terms"/);
            expect(c.html, c.name).toMatch(/href="https:\/\/silkroadai\.io\/privacy"/);
            expect(c.html, c.name).toMatch(/href="https:\/\/silkroadai\.io\/refund"/);
            // Copyright with current year (template renders at call time)
            expect(c.html, c.name).toContain(`© ${new Date().getFullYear()}`);
        }
    });
});

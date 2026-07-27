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
            topupUrl: 'https://llmroute.club/pay',
            settingsUrl: 'https://llmroute.club/balance',
        });
        // 2-decimal CNY formatting in the subject (predictable for ops grep)
        expect(c.subject).toContain('LLmRoute');
        expect(c.subject).toContain('¥4.50');
    });

    it('text body mentions threshold + remain + both URLs (so plain-text mail readers can act)', () => {
        const c = balanceAlertTemplate({
            remainCny: 2.13,
            thresholdCny: 20,
            topupUrl: 'https://llmroute.club/pay',
            settingsUrl: 'https://llmroute.club/balance',
        });
        expect(c.text).toContain('¥20.00');
        expect(c.text).toContain('¥2.13');
        expect(c.text).toContain('https://llmroute.club/pay');
        expect(c.text).toContain('https://llmroute.club/balance');
    });

    it('html body has the same data + the brand 立即充值 CTA + settings link', () => {
        const c = balanceAlertTemplate({
            remainCny: 0,
            thresholdCny: 10,
            topupUrl: 'https://llmroute.club/pay',
            settingsUrl: 'https://llmroute.club/balance',
        });
        expect(c.html).toContain('¥10.00');
        expect(c.html).toContain('¥0.00');
        // CTA button text + href
        expect(c.html).toMatch(/立即充值/);
        expect(c.html).toContain('href="https://llmroute.club/pay"');
        // Settings link to /balance
        expect(c.html).toContain('href="https://llmroute.club/balance"');
        expect(c.html).toContain('#1d1d1f');
        expect(c.html).toContain('#0e1a2a');
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
        const {
            emailVerificationTemplate,
            passwordResetTemplate,
            balanceAlertTemplate: bat,
        } = await import('@/lib/email/templates');
        cases.push({
            name: 'verify-email',
            html: emailVerificationTemplate('https://llmroute.club/verify-email?token=x', 24).html,
        });
        cases.push({
            name: 'reset-password',
            html: passwordResetTemplate('https://llmroute.club/reset-password?token=y', 30).html,
        });
        cases.push({
            name: 'balance-alert',
            html: bat({
                remainCny: 4.5,
                thresholdCny: 10,
                topupUrl: 'https://llmroute.club/pay',
                settingsUrl: 'https://llmroute.club/balance',
            }).html,
        });
        for (const c of cases) {
            // Brand wordmark in the header strip
            expect(c.html, c.name).toContain('LLmRoute');
            expect(c.html, c.name).toContain('One route. Every model.');
            // Neutral canvas + route-blue accent
            expect(c.html, c.name).toMatch(/<body[^>]*background:#f5f5f7/);
            expect(c.html, c.name).toContain('#0e1a2a');
            // Footer contact pair
            expect(c.html, c.name).toContain('Global_Ads');
            expect(c.html, c.name).toContain('support@llmroute.club');
            // Footer legal triplet
            expect(c.html, c.name).toMatch(/href="https:\/\/llmroute\.club\/terms"/);
            expect(c.html, c.name).toMatch(/href="https:\/\/llmroute\.club\/privacy"/);
            expect(c.html, c.name).toMatch(/href="https:\/\/llmroute\.club\/refund"/);
            // Copyright with current year (template renders at call time)
            expect(c.html, c.name).toContain(`© ${new Date().getFullYear()}`);
        }
    });
});

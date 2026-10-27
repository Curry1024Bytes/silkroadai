/**
 * i18n (zh/en) — English rendering of the auth pages + pay flow (WP-C).
 *
 * Default-locale behaviour is covered by the existing Chinese smoke tests
 * (they render without a provider / cookie and must stay byte-identical).
 * This file flips the locale to `en` two ways, mirroring production:
 *   - client islands: wrapped in `<LocaleProvider locale="en">` (what the
 *     root layout does from the cookie);
 *   - server pages: `@/lib/i18n/server` mocked so `getLocale()` → 'en'.
 * `/pay` additionally honours a legacy `?lang=en` query that must beat the
 * cookie — asserted with getLocale pinned to 'zh'.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Prisma } from '@prisma/client';
import { LocaleProvider } from '@/lib/i18n/client';

const mockGetLocale = vi.fn<() => Promise<'zh' | 'en'>>(async () => 'en');
vi.mock('@/lib/i18n/server', () => ({
    getLocale: () => mockGetLocale(),
    getMessages: async (d: { zh: unknown; en: unknown }) => ((await mockGetLocale()) === 'en' ? d.en : d.zh),
}));

vi.mock('next/navigation', () => ({
    useSearchParams: () => null,
    redirect: (url: string) => {
        throw Object.assign(new Error('REDIRECT'), { _redirectUrl: url });
    },
}));
vi.mock('next/headers', () => ({
    headers: async () => new Headers({ cookie: '' }),
    cookies: async () => ({ get: () => undefined }),
}));

// <BrandLogo> is an async server component (reads the tenant); renderToString
// can't pump nested async, so render the sync default <Logo> instead
// (same shim as landing-page.test.tsx).
vi.mock('@/components/brand/BrandLogo', async () => {
    const actual = await import('@/components/brand/Logo');
    return { BrandLogo: (props: Record<string, unknown>) => actual.Logo(props) };
});

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));
vi.mock('@/lib/payment/resolve-enabled-types', () => ({
    getEnabledPaymentTypes: async () => ['alipay', 'wxpay'],
}));
const mockOrderFindUnique = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: { order: { findUnique: (...args: unknown[]) => mockOrderFindUnique(...args) } },
}));

import { LoginForm } from '@/app/login/login-form';
import LoginPage from '@/app/login/page';
import { RegisterForm } from '@/app/portal/register/register-form';
import RegisterPage from '@/app/portal/register/page';
import { ForgotPasswordForm } from '@/app/forgot-password/forgot-password-form';
import ForgotPasswordPage from '@/app/forgot-password/page';
import { ResetPasswordForm } from '@/app/reset-password/reset-password-form';
import { VerifyEmailRunner } from '@/app/verify-email/verify-email-runner';
import { PayForm } from '@/app/pay/pay-form';
import PayPage from '@/app/pay/page';
import { QrPollRunner } from '@/app/pay/qr/qr-runner';
import PayResultPage from '@/app/pay/result/page';

function en(node: React.ReactElement): string {
    return renderToString(<LocaleProvider locale="en">{node}</LocaleProvider>).replace(/<!-- -->/g, '');
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetLocale.mockResolvedValue('en');
    mockGetCurrentUser.mockResolvedValue(null);
});

describe('auth client islands in English', () => {
    it('<LoginForm /> — labels, OAuth buttons, handoff CTA', () => {
        const html = en(<LoginForm next="/dashboard" />);
        expect(html).toContain('Forgot password?');
        expect(html).toContain('Log in with Google');
        expect(html).toContain('Log in with GitHub');
        expect(html).toContain('No account yet?');
        expect(html).toMatch(/<a[^>]*href="\/portal\/register"[^>]*>[^<]*Create account/);
        expect(html).not.toContain('忘记密码');
    });

    it('<RegisterForm /> — field labels, ToS line, submit, handoff CTA', () => {
        const html = en(<RegisterForm />);
        expect(html).toContain('Password (at least 8 characters)');
        expect(html).toContain('Invite code (optional)');
        expect(html).toContain('placeholder="Leave blank if you have none"');
        expect(html).toContain('I have read and agree to the');
        expect(html).toContain('Terms of Service');
        expect(html).toContain('Privacy Policy');
        expect(html).toContain('Create account');
        expect(html).toContain('Already have an account?');
        expect(html).not.toContain('邀请码');
    });

    it('<ForgotPasswordForm /> — intro + send button + back link', () => {
        const html = en(<ForgotPasswordForm />);
        expect(html).toContain('Send reset email');
        expect(html).toContain('Remembered your password?');
        expect(html).toMatch(/<a[^>]*href="\/login"[^>]*>[^<]*Back to log in/);
    });

    it('<ResetPasswordForm /> — labels + submit', () => {
        const html = en(<ResetPasswordForm token={'a'.repeat(64)} />);
        expect(html).toContain('New password (at least 8 characters)');
        expect(html).toContain('Repeat new password');
        expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Submit</);
    });

    it('<VerifyEmailRunner /> — pending copy', () => {
        const html = en(<VerifyEmailRunner token={'a'.repeat(64)} />);
        expect(html).toContain('Verifying your email…');
    });
});

describe('auth server pages in English (getLocale → en)', () => {
    it('/login — heading + locale switcher in the card header', async () => {
        const html = renderToString(await LoginPage({ searchParams: Promise.resolve({}) }));
        expect(html).toContain('>Log in</h2>');
        // <LocaleSwitcher /> is a client island (its own label comes from the
        // root-layout provider, absent here) — assert its presence structurally.
        expect(html).toMatch(/<div[^>]*role="group"[^>]*data-locale="/);
        expect(html).not.toContain('登录</h2>');
    });

    it('/login — friendly OAuth error copy is localised', async () => {
        const html = renderToString(
            await LoginPage({ searchParams: Promise.resolve({ oauth_error: 'google_denied' }) }),
        );
        expect(html).toContain('Google sign-in was cancelled');
    });

    it('/portal/register — heading, subtitle link, locale switcher', async () => {
        const html = renderToString(await RegisterPage());
        expect(html).toContain('Create your account');
        expect(html).toContain('Already have an account?');
        expect(html).toMatch(/<div[^>]*role="group"[^>]*data-locale="/);
    });

    it('/forgot-password — heading', async () => {
        const html = renderToString(await ForgotPasswordPage());
        expect(html).toContain('>Reset password</h2>');
    });
});

describe('pay flow in English', () => {
    it('<PayForm /> — provider labels, legends, submit', () => {
        const html = en(<PayForm enabledPaymentTypes={['alipay', 'wxpay', 'stripe']} />);
        expect(html).toContain('Choose an amount (CNY)');
        expect(html).toContain('Custom amount:');
        expect(html).toContain('Payment method');
        expect(html).toContain('Alipay');
        expect(html).toContain('WeChat Pay');
        expect(html).toContain('Stripe (credit card)');
        expect(html).toContain('Continue to payment');
        expect(html).not.toContain('支付宝');
    });

    it('<PayForm /> — empty providers message', () => {
        const html = en(<PayForm enabledPaymentTypes={[]} />);
        expect(html).toContain('No payment method is available right now');
    });

    it('<QrPollRunner /> — calm waiting copy', () => {
        const html = en(<QrPollRunner orderId="ord-1" accessToken={null} />);
        expect(html).toContain('Waiting for payment…');
    });

    it('/pay — legacy ?lang=en beats the cookie locale, for page AND the form island', async () => {
        mockGetLocale.mockResolvedValue('zh');
        mockGetCurrentUser.mockResolvedValue({ id: 'u1', email: 'a@b.co' });
        const html = renderToString(await PayPage({ searchParams: Promise.resolve({ lang: 'en' }) })).replace(
            /<!-- -->/g,
            '',
        );
        expect(html).toContain('Top up your account');
        expect(html).toContain('Signed in as: <strong');
        expect(html).toContain('Continue to payment');
        expect(html).toContain('Trouble topping up?');
        expect(html).not.toContain('账户充值');
    });

    it('/pay — falls back to the cookie locale without ?lang', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: 'u1', email: 'a@b.co' });
        const html = renderToString(await PayPage({ searchParams: Promise.resolve({}) }));
        expect(html).toContain('Top up your account');
    });

    it('/pay/result — COMPLETED in English', async () => {
        mockOrderFindUnique.mockResolvedValue({ id: 'o1', status: 'COMPLETED', amount: new Prisma.Decimal('10.00') });
        const html = renderToString(await PayResultPage({ searchParams: Promise.resolve({ order_id: 'o1' }) }));
        expect(html).toContain('Payment successful');
        expect(html).toContain('¥10.00 has been credited');
        expect(html).toContain('Back to /balance');
    });

    it('/pay/result — missing order param in English', async () => {
        const html = renderToString(await PayResultPage({ searchParams: Promise.resolve({}) }));
        expect(html).toContain('Invalid request');
        expect(html).toContain('Missing order parameter.');
        expect(html).toMatch(/href="\/"[^>]*>Back to home/);
    });
});

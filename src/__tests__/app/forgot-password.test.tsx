/**
 * Forgot-password entry point + form smoke.
 *
 * Customers who forget their password previously had no self-serve path —
 * /login exposed no "忘记password" link, so they had to email support. This
 * covers (a) the entry link on /login that we must not silently drop, and
 * (b) the new /forgot-password form's core structure. Both render via
 * renderToString without cookie/header mocking (forms are pure clients).
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { LoginForm } from '@/app/login/login-form';
import { ForgotPasswordForm } from '@/app/forgot-password/forgot-password-form';

describe('<LoginForm /> forgot-password entry', () => {
    it('exposes a "忘记密码?" link pointing at /forgot-password', () => {
        const html = renderToString(<LoginForm next="/dashboard" />);
        expect(html).toContain('忘记密码?');
        expect(html).toMatch(/<a[^>]*href="\/forgot-password"[^>]*>[^<]*忘记密码/);
    });
});

describe('<ForgotPasswordForm />', () => {
    it('renders an email field and the send button', () => {
        const html = renderToString(<ForgotPasswordForm />);
        expect(html).toMatch(/<input[^>]*type="email"/);
        expect(html).toContain('发送重置邮件');
    });

    it('offers a way back to /login', () => {
        const html = renderToString(<ForgotPasswordForm />);
        expect(html).toMatch(/<a[^>]*href="\/login"/);
    });
});

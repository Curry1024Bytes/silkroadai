/**
 * W7 D4 PR-I — bidirectional /login ↔ /portal/register handoff.
 *
 * Both auth pages now expose a small footer CTA pointing at the *other*
 * page so a visitor who landed on the wrong one can switch without
 * back-buttoning. The links live INSIDE each form component (rather
 * than the server-rendered page wrapper) so they're trivially
 * renderToString-testable here without mocking cookies / headers.
 *
 * Style contract (P1 design system):
 *   - small text in minor-ink (the prefix)
 *   - link in route blue, hover transitions to the stronger blue token
 *
 * The /portal/register page additionally has a top-of-card "已经有账户?
 * 前往登录" hint above the form (header subtitle); we cover the visibility
 * of *that* link via its server-rendered href in the page-level smoke
 * (verified post-deploy, not here — page is async + cookie-gated).
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { LoginForm } from '@/app/login/login-form';
import { RegisterForm } from '@/app/portal/register/register-form';

describe('<LoginForm /> footer CTA → /portal/register (W7 D4 PR-I)', () => {
    it('renders the "还没账户? 创建账户 →" handoff anchor with the right href', () => {
        const html = renderToString(<LoginForm next="/dashboard" />);
        expect(html).toContain('还没账户?');
        expect(html).toMatch(/<a[^>]*href="\/portal\/register"[^>]*>[^<]*创建账户/);
    });

    it('applies the route-blue handoff style tokens', () => {
        const html = renderToString(<LoginForm next="/dashboard" />);
        // Anchor carries the spec'd color tokens — covers regression if
        // someone "tidies" the className and drops the hover transition.
        expect(html).toMatch(
            /<a[^>]*href="\/portal\/register"[^>]*class="[^"]*text-brand-accent[^"]*hover:text-brand-accent-strong/,
        );
    });
});

describe('<RegisterForm /> footer CTA → /login (W7 D4 PR-I)', () => {
    it('renders the "已有账户? 登录 →" handoff anchor with the right href', () => {
        const html = renderToString(<RegisterForm />);
        expect(html).toContain('已有账户?');
        expect(html).toMatch(/<a[^>]*href="\/login"[^>]*>[^<]*登录/);
    });

    it('applies the muted-ink + brand-accent hover style tokens', () => {
        const html = renderToString(<RegisterForm />);
        expect(html).toMatch(/<a[^>]*href="\/login"[^>]*class="[^"]*text-muted-ink[^"]*hover:text-brand-accent/);
    });
});

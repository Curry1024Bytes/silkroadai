/**
 * W4-1 D2 — Pay form / Login form initial-render smoke.
 *
 * No jsdom + RTL infrastructure exists yet, so these are deliberately
 * shallow:  use react-dom/server to render the components to HTML and
 * scan the markup for the contract surface (5 tier buttons, custom amount
 * input, provider radios, OAuth links). Interactivity is left to D3
 * manual smoke + future RTL adoption.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { PayForm } from '@/app/pay/pay-form';
import { LoginForm } from '@/app/login/login-form';
import { FirstRechargeBonusBanner } from '@/app/pay/first-recharge-bonus-banner';

describe('<PayForm /> initial render (W4-1 D2)', () => {
    it('renders 5 default tier buttons (¥10 / ¥30 / ¥100 / ¥300 / ¥1000)', () => {
        const html = renderToString(<PayForm enabledPaymentTypes={['alipay', 'wxpay']} />);
        // React 19 SSR inserts <!-- --> between adjacent text nodes
        // (¥ literal + interpolated number), so match the digit literal alone.
        for (const tier of [10, 30, 100, 300, 1000]) {
            expect(html).toMatch(new RegExp(`>\\s*¥(<!-- -->)?${tier}\\s*<`));
        }
    });

    it('renders custom amount input', () => {
        const html = renderToString(<PayForm enabledPaymentTypes={['alipay']} />);
        expect(html).toMatch(/<input[^>]*type="number"/);
        expect(html).toContain('自定义金额');
    });

    it('renders one radio per enabled payment provider with friendly labels', () => {
        const html = renderToString(<PayForm enabledPaymentTypes={['alipay', 'wxpay', 'stripe']} />);
        // Three radio inputs, all named "payment-type"
        const radioMatches = html.match(/name="payment-type"/g) ?? [];
        expect(radioMatches.length).toBe(3);
        // Friendly labels surface
        expect(html).toContain('支付宝');
        expect(html).toContain('微信支付');
        expect(html).toContain('Stripe');
    });

    it('renders unknown provider code verbatim if no friendly label exists', () => {
        const html = renderToString(<PayForm enabledPaymentTypes={['some_new_provider']} />);
        expect(html).toContain('some_new_provider');
    });

    it('shows "no providers" message when enabledPaymentTypes is empty', () => {
        const html = renderToString(<PayForm enabledPaymentTypes={[]} />);
        expect(html).toContain('当前没有可用的支付方式');
        // No submit button when there's nothing to submit
        expect(html).not.toMatch(/<button[^>]*type="submit"/);
    });

    it('renders submit button (前往支付)', () => {
        const html = renderToString(<PayForm enabledPaymentTypes={['alipay']} />);
        expect(html).toMatch(/<button[^>]*type="submit"/);
        expect(html).toContain('前往支付');
    });
});

describe('<LoginForm /> initial render (W4-1 D2)', () => {
    it('renders email + password inputs with autocomplete hints', () => {
        const html = renderToString(<LoginForm next="/pay" />);
        expect(html).toMatch(/<input[^>]*type="email"[^>]*autoComplete="email"/);
        expect(html).toMatch(/<input[^>]*type="password"[^>]*autoComplete="current-password"/);
    });

    it('renders OAuth links to /api/auth/oauth/{google,github}/start', () => {
        const html = renderToString(<LoginForm next="/pay" />);
        expect(html).toMatch(/href="\/api\/auth\/oauth\/google\/start"/);
        expect(html).toMatch(/href="\/api\/auth\/oauth\/github\/start"/);
    });

    it('renders 登录 submit button', () => {
        const html = renderToString(<LoginForm next="/pay" />);
        expect(html).toMatch(/<button[^>]*type="submit"/);
        // Initial state: empty inputs → button disabled
        expect(html).toMatch(/disabled=""/);
    });
});

describe('<FirstRechargeBonusBanner /> SSR (W6 D1)', () => {
    // The /pay server page chooses whether to render the banner based on
    // user.first_recharge_bonus_granted (only when === false). We don't SSR
    // the whole page (it pulls in cookies + Prisma + headers); we just
    // assert the standalone banner renders the expected contract surface.
    // Page-level conditional rendering is exercised by the integration
    // tests in recharge-flow.test.ts (granted flips after first recharge).
    it('renders the 🎁 首充福利 banner with 20% bonus copy', () => {
        const html = renderToString(<FirstRechargeBonusBanner />);
        expect(html).toContain('首充福利');
        expect(html).toContain('20% bonus');
        // role="note" surface for accessibility / future RTL queries
        expect(html).toMatch(/role="note"/);
        // Yellow soft-block styling mirrors W4-2 UnverifiedBanner
        expect(html).toContain('#fff8e1');
    });
});

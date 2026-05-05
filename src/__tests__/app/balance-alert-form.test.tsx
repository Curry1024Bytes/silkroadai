/**
 * W6 D2 — BalanceAlertForm SSR smoke.
 *
 * Same shallow renderToString pattern as W4-1 D2 pay-form.test.tsx.
 * Asserts the form's contract surface for both "alert on" and "alert off"
 * (threshold=0) initial states. Interactivity (POST + status banner) is
 * left to manual smoke + future RTL adoption.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { BalanceAlertForm } from '@/app/(authenticated)/balance/balance-alert-form';

describe('<BalanceAlertForm /> SSR (W6 D2)', () => {
    it('renders the threshold input with the initial value populated', () => {
        const html = renderToString(<BalanceAlertForm initialThreshold={25} />);
        expect(html).toMatch(/<input[^>]*type="number"/);
        expect(html).toMatch(/value="25"/);
        expect(html).toContain('余额提醒设置');
    });

    it('shows "已关闭提醒" badge when initial threshold is 0', () => {
        const html = renderToString(<BalanceAlertForm initialThreshold={0} />);
        expect(html).toContain('已关闭提醒');
        // Yellow badge styling matches the W4-2 unverified-banner palette
        expect(html).toContain('#fff8e1');
    });

    it('does NOT show "已关闭提醒" when threshold > 0', () => {
        const html = renderToString(<BalanceAlertForm initialThreshold={10} />);
        expect(html).not.toContain('已关闭提醒');
    });

    it('renders a 保存 button (initially disabled because not dirty)', () => {
        const html = renderToString(<BalanceAlertForm initialThreshold={10} />);
        expect(html).toMatch(/<button[^>]*type="button"/);
        expect(html).toContain('保存');
    });

    it('mentions the 0 = opt-out copy in the descriptive text', () => {
        const html = renderToString(<BalanceAlertForm initialThreshold={10} />);
        expect(html).toMatch(/0\s*关闭提醒/);
    });
});

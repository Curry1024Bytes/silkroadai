/**
 * PR-U2 — JoinForm SSR smoke (agreement gate).
 *
 * The full behavioural flow (checkbox → POST → router.push) is exercised
 * by the operator smoke test plan. Here we just verify the initial SSR
 * shape: checkbox present, agreement copy present, submit button rendered
 * disabled (since `agreed` defaults to false).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

vi.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { JoinForm } from '@/app/(authenticated)/reseller/join-form';

describe('<JoinForm />', () => {
    it('renders the agreement-checkbox label + submit button', () => {
        const html = renderToString(<JoinForm />);
        expect(html).toContain('我已阅读并同意');
        expect(html).toContain('代理合作协议');
        expect(html).toContain('加入代理计划');
        // Checkbox unchecked by default
        expect(html).toMatch(/type="checkbox"/);
        // Submit button rendered disabled (agreed=false)
        expect(html).toMatch(/disabled/);
    });

    it('renders the hint copy explaining what happens on click', () => {
        const html = renderToString(<JoinForm />);
        expect(html).toContain('立即激活代理身份');
        expect(html).toContain('系统会为你自动生成第一个邀请码');
    });
});

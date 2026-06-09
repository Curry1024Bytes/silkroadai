/**
 * W4-2 D4 — Authenticated route group component SSR smokes.
 *
 * Pattern matches src/__tests__/app/pay-form.test.tsx — react-dom/server
 * renderToString catches initial-render contract regressions without
 * requiring jsdom + RTL setup. Interactivity is validated manually in D7
 * smoke and (later) e2e.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

// Sidebar uses next/navigation usePathname; mock it deterministically.
const mockUsePathname = vi.fn<() => string>();
vi.mock('next/navigation', () => ({
    usePathname: () => mockUsePathname(),
}));

import { Sidebar } from '@/app/(authenticated)/sidebar';
import { LogoutButton } from '@/app/(authenticated)/logout-button';
import { UnverifiedBanner } from '@/app/(authenticated)/unverified-banner';
// All four authenticated pages have been replaced with real implementations:
//   /keys (W4-2 D5) → src/__tests__/app/portal-keys/
//   /balance (W4-2 D6) → src/__tests__/app/portal-balance/
//   /usage (W4-2 D7) → src/__tests__/app/portal-usage/
// The placeholder describe block below was emptied accordingly.

afterEach(() => {
    vi.clearAllMocks();
});

describe('<Sidebar />', () => {
    it('renders the W7+T2 nav links + 充值 CTA', () => {
        mockUsePathname.mockReturnValue('/dashboard');
        const html = renderToString(<Sidebar />);
        // Primary nav items (W4-2 + W7 P2 + PR-T2 AI 生图)
        expect(html).toContain('概览');
        // PR-T2: AI 生图 inserted at second position (after 概览)
        expect(html).toContain('AI 生图');
        expect(html).toContain('API Keys');
        // 客户控制台三合一: 余额 + 用量 collapsed into 概览 (/balance + /usage
        // now 307-redirect to /dashboard), so they're no longer separate rows.
        expect(html).not.toContain('>余额<');
        expect(html).not.toContain('>用量<');
        expect(html).not.toMatch(/href="\/balance"/);
        expect(html).not.toMatch(/href="\/usage"/);
        // Bottom-pinned 充值 CTA — the W7 P2 redesign prefixed it with "+"
        expect(html).toContain('充值');
        // Hrefs present
        expect(html).toMatch(/href="\/dashboard"/);
        expect(html).toMatch(/href="\/image"/);
        expect(html).toMatch(/href="\/keys"/);
        expect(html).toMatch(/href="\/pay"/);
    });

    it('PR-T2: AI 生图 is in the second position (after 概览)', () => {
        mockUsePathname.mockReturnValue('/dashboard');
        const html = renderToString(<Sidebar />);
        const dashIdx = html.indexOf('概览');
        const imageIdx = html.indexOf('AI 生图');
        const keysIdx = html.indexOf('API Keys');
        expect(dashIdx).toBeGreaterThan(-1);
        expect(imageIdx).toBeGreaterThan(dashIdx);
        expect(keysIdx).toBeGreaterThan(imageIdx);
    });

    it('marks the active route with aria-current="page"', () => {
        mockUsePathname.mockReturnValue('/keys');
        const html = renderToString(<Sidebar />);
        // The active link gets aria-current="page"; precisely one match
        const matches = html.match(/aria-current="page"/g) ?? [];
        expect(matches.length).toBe(1);
        // And it's on the /keys link specifically. React 19 may emit
        // aria-current before or after href depending on prop order, so
        // match the link tag containing both attrs in either order.
        expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/keys"/);
    });

    it('no aria-current on a route not in the nav (e.g. /pay)', () => {
        mockUsePathname.mockReturnValue('/pay');
        const html = renderToString(<Sidebar />);
        // /pay is the bottom CTA, not in the 4 nav items, so nothing active
        expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(0);
    });
});

describe('<LogoutButton />', () => {
    it('renders a button with 退出 label', () => {
        const html = renderToString(<LogoutButton />);
        expect(html).toMatch(/<button[^>]*type="button"/);
        expect(html).toContain('退出');
        // Default state — not disabled (no `disabled=""` attribute on the button)
        expect(html).not.toMatch(/<button[^>]*disabled=""/);
    });
});

describe('<UnverifiedBanner />', () => {
    it('renders a yellow alert with 重发验证邮件 button', () => {
        // fix/resend-verification-empty-body: prop is now required.
        // The dedicated unverified-banner.test.tsx exercises the email
        // field flowing into the fetch body; here we just need a stub
        // to render the markup.
        const html = renderToString(<UnverifiedBanner email="happy@silkroadai.io" />);
        expect(html).toMatch(/role="alert"/);
        expect(html).toContain('邮箱未验证');
        expect(html).toContain('重发验证邮件');
        // Yellow tones for the unverified soft-block (not red — we're
        // reminding, not blocking). W7 P2 swapped the inline #fff8e1 hex
        // for the design-system `bg-status-warning-bg` class, which maps
        // to the same warm-amber tint.
        expect(html).toContain('bg-status-warning-bg');
        expect(html).toContain('text-status-warning-text');
    });
});

// Placeholder describe block fully retired in W4-2 D7 — all four pages
// (/dashboard, /keys, /balance, /usage) are now real and have dedicated
// test suites. See header comment above for routing.

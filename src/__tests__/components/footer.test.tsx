/**
 * W5 D5 — <Footer /> SSR smoke.
 *
 * Pattern matches W4-2 D4 components.test.tsx — react-dom/server
 * renderToString to catch initial-render regressions without jsdom.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockUsePathname = vi.fn(() => '/');
vi.mock('next/navigation', () => ({
    usePathname: () => mockUsePathname(),
}));

import { Footer } from '@/components/Footer';

beforeEach(() => {
    mockUsePathname.mockReturnValue('/');
});

describe('<Footer />', () => {
    it('renders the 3 legal nav links with correct href', () => {
        const html = renderToString(<Footer />);
        expect(html).toMatch(/<a[^>]*href="\/terms"[^>]*>服务条款<\/a>/);
        expect(html).toMatch(/<a[^>]*href="\/privacy"[^>]*>隐私政策<\/a>/);
        expect(html).toMatch(/<a[^>]*href="\/refund"[^>]*>退款政策<\/a>/);
    });

    it('shows customer support contacts (微信 LLmRoute + support email)', () => {
        const html = renderToString(<Footer />);
        expect(html).toContain('LLmRoute');
        expect(html).toMatch(/href="mailto:support@llmroute\.club"/);
        expect(html).toContain('support@llmroute.club');
    });

    it('shows current year in copyright line', () => {
        const html = renderToString(<Footer />);
        const year = new Date().getFullYear();
        // React 19 inserts <!-- --> between adjacent text nodes when one
        // is a literal and one is interpolated. The brand-logo PR moved
        // "LLmRoute" out of plain text into the <Logo /> component
        // (rendered as an <img alt="LLmRoute">), so the copyright
        // line now reads `© 2026` standalone with the brandmark adjacent.
        expect(html).toMatch(new RegExp(`©\\s*(?:<!-- -->)?\\s*${year}`));
    });

    it('renders the LLmRoute brandmark via <Logo />', () => {
        const html = renderToString(<Footer />);
        // Logo component renders <img alt="LLmRoute" wrapped in
        // <a href="/"> with aria-label. React's SSR sorts attributes
        // alphabetically (aria-label before href), so the assertions
        // check each attribute independently rather than mandating an
        // order on the same element.
        expect(html).toMatch(/<img[^>]*alt="LLmRoute"/);
        const linkOpen = html.match(/<a\b[^>]*\baria-label="LLmRoute"[^>]*>/);
        expect(linkOpen, 'expected an <a> with aria-label="LLmRoute"').not.toBeNull();
        expect(linkOpen![0]).toContain('href="/"');
    });

    it('uses the neutral public-surface design tokens', () => {
        const html = renderToString(<Footer />);
        expect(html).toContain('bg-paper');
        expect(html).toContain('border-brand-border');
        expect(html).toContain('text-muted-ink');
    });

    it('renders the page-nav link to /models for SEO + customer reference', () => {
        const html = renderToString(<Footer />);
        expect(html).toMatch(/<a[^>]*href="\/models"[^>]*>模型清单<\/a>/);
        expect(html).toMatch(/<a[^>]*href="\/docs"[^>]*>文档<\/a>/);
    });

    it('does not append a public footer below the authenticated workspace shell', () => {
        mockUsePathname.mockReturnValue('/dashboard');
        const html = renderToString(<Footer />);
        expect(html).toBe('');
    });
});

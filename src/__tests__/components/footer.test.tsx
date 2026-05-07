/**
 * W5 D5 — <Footer /> SSR smoke.
 *
 * Pattern matches W4-2 D4 components.test.tsx — react-dom/server
 * renderToString to catch initial-render regressions without jsdom.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Footer } from '@/components/Footer';

describe('<Footer />', () => {
    it('renders the 3 legal nav links with correct href', () => {
        const html = renderToString(<Footer />);
        expect(html).toMatch(/<a[^>]*href="\/terms"[^>]*>服务条款<\/a>/);
        expect(html).toMatch(/<a[^>]*href="\/privacy"[^>]*>隐私政策<\/a>/);
        expect(html).toMatch(/<a[^>]*href="\/refund"[^>]*>退款政策<\/a>/);
    });

    it('shows customer support contacts (微信 Global_Ads + support email)', () => {
        const html = renderToString(<Footer />);
        expect(html).toContain('Global_Ads');
        expect(html).toMatch(/href="mailto:support@silkroadai\.io"/);
        expect(html).toContain('support@silkroadai.io');
    });

    it('shows current year in copyright line', () => {
        const html = renderToString(<Footer />);
        const year = new Date().getFullYear();
        // React 19 inserts <!-- --> between adjacent text nodes when one
        // is a literal and one is interpolated. The brand-logo PR moved
        // "Silk Road AI" out of plain text into the <Logo /> component
        // (rendered as an <img alt="Silk Road AI">), so the copyright
        // line now reads `© 2026` standalone with the brandmark adjacent.
        expect(html).toMatch(new RegExp(`©\\s*(?:<!-- -->)?\\s*${year}`));
    });

    it('renders the Silk Road AI brandmark via <Logo />', () => {
        const html = renderToString(<Footer />);
        // Logo component renders <img alt="Silk Road AI" wrapped in
        // <a href="/"> with aria-label. React's SSR sorts attributes
        // alphabetically (aria-label before href), so the assertions
        // check each attribute independently rather than mandating an
        // order on the same element.
        expect(html).toMatch(/<img[^>]*alt="Silk Road AI"/);
        const linkOpen = html.match(/<a\b[^>]*\baria-label="Silk Road AI"[^>]*>/);
        expect(linkOpen, 'expected an <a> with aria-label="Silk Road AI"').not.toBeNull();
        expect(linkOpen![0]).toContain('href="/"');
    });

    it('uses design-system warm tokens (paper-muted surface + muted-ink links)', () => {
        const html = renderToString(<Footer />);
        // W7 P3 swapped inline #5a6478 / #fff for design-system tokens.
        // Paper-muted surface + brand-border top separator + muted-ink
        // text gives the footer the same warm-white feel as the rest of
        // the W7 portal/landing chrome.
        expect(html).toContain('bg-paper-muted');
        expect(html).toContain('border-brand-border');
        expect(html).toContain('text-muted-ink');
    });

    it('renders the page-nav link to /models for SEO + customer reference', () => {
        const html = renderToString(<Footer />);
        expect(html).toMatch(/<a[^>]*href="\/models"[^>]*>模型清单<\/a>/);
    });
});

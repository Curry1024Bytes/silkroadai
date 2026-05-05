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
        // is a literal and one is interpolated, so match the year as a
        // standalone token rather than asserting a contiguous substring.
        expect(html).toMatch(new RegExp(`©\\s*(?:<!-- -->)?\\s*${year}\\s*(?:<!-- -->)?\\s*Silk Road AI`));
    });

    it('uses the secondary text color (#5a6478) for the body / nav links', () => {
        const html = renderToString(<Footer />);
        expect(html).toContain('#5a6478');
    });
});

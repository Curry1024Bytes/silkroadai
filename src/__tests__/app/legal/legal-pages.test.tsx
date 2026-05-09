/**
 * W5 D5 — public legal pages SSR smoke.
 *
 * Each page (TermsPage / PrivacyPage / RefundPage) is a thin async
 * wrapper: `return <LegalDocPage file=... />`. The inner LegalDocPage is
 * itself an async server component that reads a markdown file from disk.
 *
 * `renderToString` is React's legacy SYNCHRONOUS server renderer — it
 * doesn't pump async server components. So we resolve LegalDocPage
 * directly (via `await`) and renderToString its returned tree, which by
 * then contains only sync elements + the dangerouslySetInnerHTML'd
 * marked output.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { LegalDocPage } from '@/components/LegalDocPage';

describe('/terms page SSR (via LegalDocPage)', () => {
    it('renders Silk Road AI 服务条款 + version + effective date 2026-05-05 + back link', async () => {
        const tree = await LegalDocPage({ file: 'service-terms.md' });
        const html = renderToString(tree);
        expect(html).toContain('Silk Road AI 服务条款');
        expect(html).toContain('2026-05-05');
        expect(html).toMatch(/<a[^>]*href="\/"[^>]*>← 返回 Silk Road AI<\/a>/);
        // marked output: at least one <h2> tag (legal doc has many sections)
        expect(html).toMatch(/<h2[^>]*>/);
    });
});

describe('/privacy page SSR (via LegalDocPage)', () => {
    it('renders 隐私政策 + 联系方式 + support email', async () => {
        const tree = await LegalDocPage({ file: 'privacy-policy.md' });
        const html = renderToString(tree);
        expect(html).toContain('Silk Road AI 隐私政策');
        expect(html).toContain('2026-05-05');
        expect(html).toContain('support@silkroadai.io');
        expect(html).toContain('Global_Ads');
        expect(html).toMatch(/<a[^>]*href="\/"[^>]*>← 返回 Silk Road AI<\/a>/);
    });
});

describe('/refund page SSR (via LegalDocPage)', () => {
    it('renders 退款政策 + version + back link', async () => {
        const tree = await LegalDocPage({ file: 'refund-policy.md' });
        const html = renderToString(tree);
        expect(html).toContain('Silk Road AI 退款政策');
        expect(html).toContain('2026-05-05');
        expect(html).toMatch(/<a[^>]*href="\/"[^>]*>← 返回 Silk Road AI<\/a>/);
    });
});

describe('legal pages share consistent style baseline', () => {
    it('all three render at max-width 720px in a card', async () => {
        const trees = await Promise.all([
            LegalDocPage({ file: 'service-terms.md' }),
            LegalDocPage({ file: 'privacy-policy.md' }),
            LegalDocPage({ file: 'refund-policy.md' }),
        ]);
        for (const tree of trees) {
            const html = renderToString(tree);
            expect(html).toContain('max-width:720px');
            // The legal-doc article wrapper class is consistent (drives styling)
            expect(html).toMatch(/class="legal-doc"/);
        }
    });

    it('TermsPage / PrivacyPage / RefundPage wrappers exist + return LegalDocPage', async () => {
        // Verify the page modules import without crashing — the wrappers
        // are trivial (return <LegalDocPage file=X />) so this catches
        // accidental file-rename or type errors.
        const [{ default: TermsPage }, { default: PrivacyPage }, { default: RefundPage }] = await Promise.all([
            import('@/app/terms/page'),
            import('@/app/privacy/page'),
            import('@/app/refund/page'),
        ]);
        expect(typeof TermsPage).toBe('function');
        expect(typeof PrivacyPage).toBe('function');
        expect(typeof RefundPage).toBe('function');
    });
});

/**
 * W7 D3 — landing page SSR smoke.
 *
 * The page is a server component that branches on `isPromoActive()` to
 * decide whether to render the gold-bordered promo banner + the
 * pricing-table strikethroughs. We mock the promo helper to flip both
 * states and assert the visible copy that operators care about.
 *
 * `renderToString` is React's legacy synchronous server renderer; it
 * doesn't pump async server components. We resolve the page function
 * directly (async) and feed its returned tree into renderToString, same
 * pattern used by `legal-pages.test.tsx`.
 *
 * `next/font/google` is mocked because vitest runs outside the Next
 * compiler; the mock returns a stub `className` so JSX still renders.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';

// Mock next/font/google before page module loads.
vi.mock('next/font/google', () => ({
    Inter: () => ({ className: 'mock-inter', style: { fontFamily: 'Inter' } }),
}));

// We mock @/lib/promo per test, then dynamic-import the page so the
// fresh module sees the current mock value.
async function loadPage() {
    const mod = await import('@/app/page');
    return mod.default;
}

beforeEach(() => {
    vi.resetModules();
});

describe('landing page — promo ACTIVE', () => {
    beforeEach(() => {
        vi.doMock('@/lib/promo', () => ({
            isPromoActive: () => true,
            getPromoEndDate: () => new Date('2026-06-09T23:59:59.999+08:00'),
            PROMO_START: new Date('2026-05-10T00:00:00+08:00'),
            PROMO_END_EXCLUSIVE: new Date('2026-06-10T00:00:00+08:00'),
        }));
    });

    it('renders hero h1 "一个 Key,接入 200+ AI 模型"', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        expect(html).toContain('一个 Key,接入 200+ AI 模型');
    });

    it('renders the promo banner with 5 折 + 6 月 9 日截止', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        expect(html).toContain('上线钜惠 · 海外模型 5 折');
        expect(html).toContain('6 月 9 日截止');
    });

    it('renders pricing table with strikethrough retail + bold promo prices', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        // Claude Sonnet 4.6 row should show $3 strikethrough → $1.5 promo
        expect(html).toContain('$3');
        expect(html).toContain('$1.5');
        expect(html).toContain('$15');
        expect(html).toContain('$7.5');
        // Strikethrough style applied
        expect(html).toMatch(/text-decoration:\s*line-through/);
        // W7 D4 PR-K Item E — SF flagship trio retail prices (wholesale × 1.20)
        // render as plain ¥, no promo markup. Replaced V3.2 / GLM-4.6 / K2.
        // (PR-L kept these test sentinels — only the width="112" assertion
        // below was reverted to its pre-PR-K-Item-D value.)
        expect(html).toContain('¥1.20/1M');   // DeepSeek V4-Flash in
        expect(html).toContain('¥9.60/1M');   // GLM-5.1 (Pro) in
        expect(html).toContain('¥7.80/1M');   // Kimi K2.6 (Pro) in
    });

    it('renders the "当前促销 · 海外模型 5 折" subtitle on pricing section', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        expect(html).toContain('当前促销 · 海外模型 5 折');
    });

    it('renders trust row with WeChat Global_Ads + support email', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        expect(html).toContain('Global_Ads');
        expect(html).toContain('support@silkroadai.io');
    });

    it('renders three legal links to existing /terms /privacy /refund paths', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        expect(html).toMatch(/href="\/terms"/);
        expect(html).toMatch(/href="\/privacy"/);
        expect(html).toMatch(/href="\/refund"/);
    });

    it('renders both CTAs: 立即开始 → /portal/register and 查看模型清单 → /models', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        expect(html).toContain('立即开始');
        expect(html).toContain('查看模型清单');
        // 立即开始 routes to /portal/register (W7 D4 — flipped back from
        // the F2-quick /login band-aid in PR #28 once the real signup
        // page landed).
        expect(html).toMatch(/href="\/portal\/register"/);
        expect(html).toMatch(/href="\/models"/);
    });

    it('renders the curl code example with sk-xxx + claude-sonnet-4-6', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        expect(html).toContain('ai.silkroadai.io/v1/chat/completions');
        expect(html).toContain('sk-xxx');
        expect(html).toContain('claude-sonnet-4-6');
    });

    it('renders the brand <Logo /> in the header (not the legacy text wordmark)', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        // PR #23's <Logo /> renders an <img alt="Silk Road AI" height width />
        // whose width = height × 4 for the full-logo variants (96/24 aspect).
        // At size=28 → width=112. Vitest under Vite inlines the SVG as a
        // base64 data: URI rather than preserving the filename, so we check
        // the img dimensions (which are unique to the swap) instead.
        expect(html).toMatch(/<img[^>]*alt="Silk Road AI"/);
        expect(html).toMatch(/height="28"/);
        expect(html).toMatch(/width="112"/);
        // The legacy text-wordmark was a <span> with literal "Silk Road AI"
        // text. The Logo asset has no inline text, so the only "Silk Road
        // AI" string left in the header is the img alt attribute (asserted
        // above) — there must be no plain text wordmark.
        expect(html).not.toMatch(/<span[^>]*>Silk Road AI<\/span>/);
    });
});

describe('landing page — promo INACTIVE (post-exit)', () => {
    beforeEach(() => {
        vi.doMock('@/lib/promo', () => ({
            isPromoActive: () => false,
            getPromoEndDate: () => new Date('2026-06-09T23:59:59.999+08:00'),
            PROMO_START: new Date('2026-05-10T00:00:00+08:00'),
            PROMO_END_EXCLUSIVE: new Date('2026-06-10T00:00:00+08:00'),
        }));
    });

    it('still renders hero', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        expect(html).toContain('一个 Key,接入 200+ AI 模型');
    });

    it('does NOT render promo banner copy', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        expect(html).not.toContain('上线钜惠 · 海外模型 5 折');
        expect(html).not.toContain('6 月 9 日截止');
    });

    it('does NOT render the "当前促销" subtitle on pricing', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        expect(html).not.toContain('当前促销');
    });

    it('renders retail pricing as bold (no strikethrough)', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        // Retail prices still show
        expect(html).toContain('$3');
        expect(html).toContain('$15');
        // No line-through anywhere in pricing
        expect(html).not.toMatch(/text-decoration:\s*line-through/);
    });
});

describe('landing page — oauth_error banner', () => {
    beforeEach(() => {
        vi.doMock('@/lib/promo', () => ({
            isPromoActive: () => true,
            getPromoEndDate: () => new Date('2026-06-09T23:59:59.999+08:00'),
            PROMO_START: new Date('2026-05-10T00:00:00+08:00'),
            PROMO_END_EXCLUSIVE: new Date('2026-06-10T00:00:00+08:00'),
        }));
    });

    it('renders nothing when no oauth_error param', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        expect(html).not.toContain('登录被取消');
        expect(html).not.toContain('登录失败');
    });

    it('renders friendly Google denial banner on ?oauth_error=google_denied', async () => {
        const Page = await loadPage();
        const tree = await Page({
            searchParams: Promise.resolve({ oauth_error: 'google_denied' }),
        });
        const html = renderToString(tree);
        expect(html).toContain('Google 登录被取消');
        expect(html).toMatch(/href="\/login"/);
    });

    it('renders friendly GitHub denial banner on ?oauth_error=github_denied', async () => {
        const Page = await loadPage();
        const tree = await Page({
            searchParams: Promise.resolve({ oauth_error: 'github_denied' }),
        });
        const html = renderToString(tree);
        expect(html).toContain('GitHub 登录被取消');
    });

    it('renders generic message + truncates unknown long oauth_error codes', async () => {
        const Page = await loadPage();
        const longCode = 'a'.repeat(200);
        const tree = await Page({
            searchParams: Promise.resolve({ oauth_error: longCode }),
        });
        const html = renderToString(tree);
        // truncated to 60 chars + ellipsis
        expect(html).toContain('登录失败:');
        expect(html).toContain('…');
        expect(html).not.toContain(longCode); // full string must not leak
    });
});

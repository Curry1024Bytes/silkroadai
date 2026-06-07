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

// P6a: the landing header now uses the async <BrandLogo> (reads getCurrentTenant).
// Render it as the default platform <Logo> (synchronous) so renderToString still
// works and the brand-logo assertion (img alt="Silk Road AI" 28×112) holds.
vi.mock('@/components/brand/BrandLogo', async () => {
    const actual = await vi.importActual<typeof import('@/components/brand/Logo')>('@/components/brand/Logo');
    return { BrandLogo: (props: Record<string, unknown>) => actual.Logo(props) };
});

// We mock @/lib/promo per test, then dynamic-import the page so the
// fresh module sees the current mock value.
async function loadPage() {
    const mod = await import('@/app/page');
    return mod.default;
}

beforeEach(() => {
    vi.resetModules();
});

// W8 D1.5 (2026-05-21):W7 promo 永久替换为新 ¥-定价。原"promo ACTIVE / promo
// INACTIVE"双块结构折叠 — page.tsx 现在硬编码 promoActive = false,promo helper
// mock 不再影响渲染。3 个 promo 专属 it()(banner / strikethrough / "5 折"
// subtitle)删除;其余通用渲染测试(hero / CTAs / Logo / GPU / 登录按钮等)
// 沿用 describe 头。
describe('landing page — general rendering (post-permanent-pricing)', () => {
    beforeEach(() => {
        // mock 留着兼容旧测试代码 — page.tsx 不再调用 isPromoActive,mock
        // value 实际上无作用,但保留以防有 import-time 副作用。
        vi.doMock('@/lib/promo', () => ({
            isPromoActive: () => false,
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

    it('renders dual-card pricing poster: 号池低价 ¥/$1 trio + 企业合规 折扣 trio (PR #66/#68)', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        // W8 PR #66 rebuilt PricingTeaser to dual-card poster v3; PR #68
        // applied 2026-05-22 round-2 prices: ChatGPT ¥0.2 / Claude ¥1.3 /
        // Gemini ¥0.5 per $1 官方等价额度.
        expect(html).toContain('海外模型 · 号池低价');
        expect(html).toContain('¥0.2'); // ChatGPT
        expect(html).toContain('¥1.3'); // Claude
        expect(html).toContain('¥0.5'); // Gemini
        // 企业 / 合规渠道 card — 折扣 trio + 云厂商 label
        expect(html).toContain('企业 / 合规渠道 · 官方授权');
        expect(html).toContain('3.8 折'); // Azure OpenAI
        expect(html).toContain('5.0 折'); // AWS Bedrock
        expect(html).toContain('2.3 折'); // Vertex AI / t3 池
        expect(html).toContain('Azure OpenAI');
        expect(html).toContain('AWS Bedrock');
    });

    // W7 D4 PR-R Item B — the legacy in-page <Trust /> prose row
    // duplicated the global <Footer />'s contact + legal-link block.
    // Trust is gone; the global footer covers Global_Ads / support@ /
    // /terms / /privacy / /refund (asserted in
    // src/__tests__/components/footer.test.tsx).
    it('does NOT render the legacy in-page Trust prose row (PR-R)', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        // Distinctive copy that only ever lived in <Trust /> — not
        // surfaced anywhere else (Footer says "Connecting Global
        // Intelligence", not this string).
        expect(html).not.toContain('由 Silk Road AI 运营团队维护');
        expect(html).not.toContain('海外节点部署 · HTTPS 全程加密');
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

    it('renders the GPU 租赁 outline CTA in the header (W7 D4 PR-Q)', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        // PR-Q surfaces GPU rental as a brand-accent (gold) outline button
        // in the sticky header. Operator visual feedback after PR-P shipped:
        // footer-only entry was too buried for a high-ASP product line.
        expect(html).toContain('GPU 租赁');
        expect(html).toMatch(/href="\/gpu"/);
    });

    it('does NOT render a header 登录 button — /dashboard CTA covers both states (W7 D4 PR-R Item A)', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        // PR-R Item A drops the standalone "登录" header link. The
        // 进入控制台 → CTA already routes guests to /login (via the
        // W7 PR-I middleware) and signed-in users to /dashboard, so
        // the lone "登录" button was redundant + visually crowded
        // alongside GPU 租赁 and the primary control-room CTA.
        expect(html).not.toMatch(/<a[^>]*href="\/login"[^>]*>登录<\/a>/);
        expect(html).not.toMatch(/<a[^>]*>登录<\/a>/);
    });

    it('does NOT render the W7-PR-P "更多:" footer row (removed in W7 D4 PR-Q)', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        // PR-P inlined a "更多:GPU 租赁 · 集成文档 · 模型清单" row in the
        // trust footer. PR-Q removed it once GPU got promoted to the header
        // — the row read as a redundant secondary nav next to legal links.
        expect(html).not.toMatch(/<strong[^>]*>更多<\/strong>/);
    });
});

describe('landing page — permanent ¥ pricing (post W8 D1.5, 2026-05-21)', () => {
    beforeEach(() => {
        vi.doMock('@/lib/promo', () => ({
            isPromoActive: () => false,
            getPromoEndDate: () => new Date('2026-06-09T23:59:59.999+08:00'),
            PROMO_START: new Date('2026-05-10T00:00:00+08:00'),
            PROMO_END_EXCLUSIVE: new Date('2026-06-10T00:00:00+08:00'),
        }));
    });

    it('does NOT render W7 promo banner copy(W7 promo 已永久结束)', async () => {
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

    it('renders ¥/$1 pricing with 官方折扣 badges, no strikethrough', async () => {
        const Page = await loadPage();
        const tree = await Page({ searchParams: Promise.resolve({}) });
        const html = renderToString(tree);
        // W8 PR #68 — per-$1 等价额度定价 + "官方仅 X%" badge:
        // ChatGPT ¥0.2/$1 = 官方 2.9%,Claude ¥1.3/$1 = 19%,Gemini ¥0.5/$1 = 7.3%
        expect(html).toContain('官方仅 2.9%');
        expect(html).toContain('官方仅 19%');
        expect(html).toContain('官方仅 7.3%');
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

/**
 * W7 D4 — custom 404 + 500 page SSR smokes.
 *
 * Same react-dom/server renderToString pattern as legal-pages /
 * landing-page tests. We assert on the visible copy + structural
 * elements that customers see; the styling tokens are spot-checked but
 * we don't enumerate every Tailwind class.
 *
 * The 500 page (`src/app/error.tsx`) is a Next-mandated 'use client'
 * component because the framework hands it `error` + `reset` props.
 * We render it directly with a fabricated error to exercise the digest
 * branch — there's no actual error-boundary wiring involved at test
 * time, just the JSX tree.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import NotFound from '@/app/not-found';
import ErrorBoundary from '@/app/error';

describe('<NotFound /> SSR (W7 D4)', () => {
    it('renders the 404 numeric badge + "页面没找到" headline', () => {
        const html = renderToString(<NotFound />);
        expect(html).toContain('404');
        expect(html).toContain('页面没找到');
    });

    it('renders both navigation CTAs (返回首页 + 查看模型清单)', () => {
        const html = renderToString(<NotFound />);
        expect(html).toContain('返回首页');
        expect(html).toContain('查看模型清单');
        // hrefs land users somewhere useful, not nowhere
        expect(html).toMatch(/href="\/"/);
        expect(html).toMatch(/href="\/models"/);
    });

    it('exposes contact pair (微信 Global_Ads + support email)', () => {
        const html = renderToString(<NotFound />);
        expect(html).toContain('Global_Ads');
        expect(html).toContain('support@silkroadai.io');
        expect(html).toMatch(/href="mailto:support@silkroadai\.io"/);
    });

    it('uses W7 P1 design tokens (paper bg + brand-accent 404 + navy heading)', () => {
        const html = renderToString(<NotFound />);
        // Class-token spot checks (non-exhaustive — guards the design
        // system contract without coupling to every utility class).
        expect(html).toContain('bg-paper');
        expect(html).toContain('text-brand-accent');
        expect(html).toContain('text-navy');
        // No legacy hex literals leaked
        expect(html).not.toContain('#0a1535');
        expect(html).not.toContain('#5a6478');
    });

    it('renders the brand <Logo /> (primary-flat for light bg)', () => {
        const html = renderToString(<NotFound />);
        // PR #23's <Logo /> renders <img alt="Silk Road AI">. W7 D4 PR-K
        // cropped the wordmark viewBox 96→88, so aspect is now 88/24
        // (≈3.667). At size=32 → width = round(32 × 88 / 24) = 117.
        expect(html).toMatch(/<img[^>]*alt="Silk Road AI"/);
        expect(html).toMatch(/height="32"/);
        expect(html).toMatch(/width="117"/);
    });

    it('tone is neutral — no jokes, no apologies, no pet metaphors', () => {
        const html = renderToString(<NotFound />);
        // Sanity-guard against future drift; pin the literal copy this
        // test was written against. Brief: "中性不人格化".
        expect(html).toContain('您访问的链接可能已变更或不存在');
        expect(html).not.toMatch(/oops|抱歉|sorry|对不起/i);
    });
});

describe('<ErrorBoundary /> (500) SSR (W7 D4)', () => {
    function makeProps(opts: { digest?: string } = {}) {
        const error = new Error('test failure') as Error & { digest?: string };
        if (opts.digest) error.digest = opts.digest;
        return { error, reset: () => {} };
    }

    it('renders the 500 numeric badge + "服务暂不可用" headline', () => {
        const html = renderToString(<ErrorBoundary {...makeProps()} />);
        expect(html).toContain('500');
        expect(html).toContain('服务暂不可用');
        expect(html).toContain('我们已收到错误,请稍后重试');
    });

    it('renders 返回首页 + 进入控制台 CTAs', () => {
        const html = renderToString(<ErrorBoundary {...makeProps()} />);
        expect(html).toContain('返回首页');
        expect(html).toContain('进入控制台');
        expect(html).toMatch(/href="\/"/);
        expect(html).toMatch(/href="\/dashboard"/);
    });

    it('shows the digest when Next provides one (ops grep affordance)', () => {
        const html = renderToString(<ErrorBoundary {...makeProps({ digest: 'abc123def' })} />);
        expect(html).toContain('错误编号');
        expect(html).toContain('abc123def');
    });

    it('hides the digest line when no digest is set (defensive — Next may omit)', () => {
        const html = renderToString(<ErrorBoundary {...makeProps()} />);
        expect(html).not.toContain('错误编号');
    });

    it('does NOT leak the raw error.message (Next strips in prod; we double-defend)', () => {
        const html = renderToString(<ErrorBoundary {...makeProps({ digest: 'aaa' })} />);
        // The error.message we passed is "test failure" — must not appear
        // in the rendered output regardless of whether Next strips it
        // upstream (defense-in-depth: even if a future Next version
        // forwards the raw message, we don't render it).
        expect(html).not.toContain('test failure');
    });

    it('exposes contact pair (微信 Global_Ads + support email)', () => {
        const html = renderToString(<ErrorBoundary {...makeProps()} />);
        expect(html).toContain('Global_Ads');
        expect(html).toContain('support@silkroadai.io');
        expect(html).toMatch(/href="mailto:support@silkroadai\.io"/);
    });

    it('uses W7 P1 design tokens', () => {
        const html = renderToString(<ErrorBoundary {...makeProps()} />);
        expect(html).toContain('bg-paper');
        expect(html).toContain('text-brand-accent');
        expect(html).toContain('text-navy');
        expect(html).not.toContain('#0a1535');
    });
});

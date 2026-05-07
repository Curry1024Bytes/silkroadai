/**
 * /docs SSR smoke (W7 D4 PR-G — Tier 2).
 *
 * The /docs page is server-rendered with no client JS. Same
 * react-dom/server pattern used elsewhere — assert key copy +
 * structural anchors so a reader can verify the contract surface
 * without spinning up the dev server.
 *
 * Coverage:
 *   - Header chrome (logo + nav)
 *   - 通用配置 box surfaces both base URLs + /keys + /models links
 *   - 6 agent sections all present with the expected anchor IDs
 *   - Each agent section has its official-docs link with the right URL
 *   - Code snippets contain the right base URLs (verified live: /v1
 *     for OpenAI, root for Anthropic) and the W7 sample model names
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import DocsPage from '@/app/docs/page';

describe('/docs page — header + chrome', () => {
    it('renders the brand <Logo /> and main heading 集成文档', () => {
        const html = renderToString(<DocsPage />);
        expect(html).toMatch(/<img[^>]*alt="Silk Road AI"/);
        expect(html).toContain('集成文档');
    });

    it('exposes both Anthropic + OpenAI base URLs in the 通用配置 card', () => {
        const html = renderToString(<DocsPage />);
        expect(html).toContain('https://ai.silkroadai.io/v1');
        expect(html).toContain('https://ai.silkroadai.io');
        expect(html).toContain('OpenAI 兼容 Base URL');
        expect(html).toContain('Anthropic 兼容 Base URL');
    });

    it('links to /portal/register, /keys, /models from the chrome', () => {
        const html = renderToString(<DocsPage />);
        expect(html).toMatch(/href="\/portal\/register"/);
        expect(html).toMatch(/href="\/keys"/);
        expect(html).toMatch(/href="\/models"/);
    });
});

describe('/docs page — 6 agent sections', () => {
    it('all 6 anchor sections render with the right IDs (toc consistency)', () => {
        const html = renderToString(<DocsPage />);
        for (const id of [
            'cursor',
            'cline',
            'continue',
            'claude-code',
            'python-sdk',
            'node-sdk',
        ]) {
            expect(html, `section #${id} present`).toMatch(
                new RegExp(`<section[^>]*id="${id}"`),
            );
        }
    });

    it('TOC list links to all 6 anchors via #', () => {
        const html = renderToString(<DocsPage />);
        for (const id of [
            'cursor',
            'cline',
            'continue',
            'claude-code',
            'python-sdk',
            'node-sdk',
        ]) {
            expect(html, `TOC #${id} link present`).toMatch(
                new RegExp(`href="#${id}"`),
            );
        }
    });

    it('every agent section links to its official docs URL', () => {
        const html = renderToString(<DocsPage />);
        // Each URL is one we WebFetched + verified during pre-build research.
        // If any of these break, search engines + customers may follow stale
        // links; the test surfaces the breakage at PR time.
        const officialUrls = [
            'https://cursor.com/docs',
            'https://docs.cline.bot',
            'https://docs.continue.dev',
            'https://code.claude.com/docs/en/env-vars',
            'https://github.com/openai/openai-python',
            'https://github.com/openai/openai-node',
        ];
        for (const u of officialUrls) {
            expect(html, `official docs link for ${u}`).toContain(`href="${u}"`);
        }
    });
});

describe('/docs page — code snippets ground-truthed', () => {
    it('Claude Code section names ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN env vars', () => {
        const html = renderToString(<DocsPage />);
        // Both env vars verified against the official Claude Code docs
        // during pre-build research. Verbatim-quoted env var names are
        // the API contract we depend on.
        expect(html).toContain('ANTHROPIC_BASE_URL');
        expect(html).toContain('ANTHROPIC_AUTH_TOKEN');
    });

    it('Python SDK snippet uses base_url (snake_case) + api_key', () => {
        const html = renderToString(<DocsPage />);
        // Verified against github.com/openai/openai-python during pre-build
        // research — the Python SDK constructor uses snake_case `base_url`
        // and `api_key`.
        expect(html).toContain('base_url=');
        expect(html).toContain('api_key=');
        expect(html).toContain('https://ai.silkroadai.io/v1');
        expect(html).toContain('from openai import OpenAI');
    });

    it('Node SDK snippet uses baseURL (camelCase) + apiKey', () => {
        const html = renderToString(<DocsPage />);
        // Verified against github.com/openai/openai-node — the Node SDK
        // constructor uses camelCase `baseURL` + `apiKey`.
        expect(html).toContain('baseURL:');
        expect(html).toContain('apiKey:');
        // React renderToString escapes single quotes in text content as
        // &#x27; — match either form for robustness across React minor
        // versions.
        expect(html).toMatch(/import OpenAI from\s*(?:'|&#x27;)openai(?:'|&#x27;);/);
    });

    it('sample models reflect W7 SKUs (claude-sonnet-4-6 + gpt-5.4)', () => {
        const html = renderToString(<DocsPage />);
        expect(html).toContain('claude-sonnet-4-6');
        expect(html).toContain('gpt-5.4');
    });
});

describe('/docs page — page-level metadata', () => {
    it('exposes a Chinese title + description in the metadata export', async () => {
        const mod = await import('@/app/docs/page');
        const meta = mod.metadata;
        expect(meta.title).toContain('集成文档');
        expect(typeof meta.description).toBe('string');
        expect((meta.description as string).length).toBeGreaterThan(20);
    });
});

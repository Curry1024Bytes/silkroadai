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

    it('renders the ← 返回 affordance above the h1 (back-to-previous-page)', () => {
        const html = renderToString(<DocsPage />);
        // Now a <BackButton> (browser back) instead of a fixed href="/" link.
        expect(html).toContain('返回');
        expect(html).toMatch(/<button[^>]*>[\s\S]*返回/);
    });
});

describe('/docs page — 6 agent sections', () => {
    it('all 8 anchor sections render with the right IDs (toc consistency)', () => {
        const html = renderToString(<DocsPage />);
        // PR-S inserted a Gemini section (anchor=gemini) between node-sdk
        // and errors. Errors stays last; section count = 8.
        for (const id of ['cursor', 'cline', 'continue', 'claude-code', 'python-sdk', 'node-sdk', 'gemini', 'errors']) {
            expect(html, `section #${id} present`).toMatch(new RegExp(`<section[^>]*id="${id}"`));
        }
    });

    it('TOC list links to all 8 anchors via #', () => {
        const html = renderToString(<DocsPage />);
        for (const id of ['cursor', 'cline', 'continue', 'claude-code', 'python-sdk', 'node-sdk', 'gemini', 'errors']) {
            expect(html, `TOC #${id} link present`).toMatch(new RegExp(`href="#${id}"`));
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

describe('/docs page — W7 D4 PR-H Tier B common-errors section', () => {
    it('renders the 常见错误码 heading + the 3 stable error codes', () => {
        const html = renderToString(<DocsPage />);
        // Section heading
        expect(html).toContain('常见错误码');
        // 3 documented codes (these are stable regardless of how the
        // 402-vs-403 status rewriting later resolves)
        expect(html).toContain('invalid_authentication');
        expect(html).toContain('insufficient_user_quota');
        expect(html).toContain('no available channel');
    });

    it('links insufficient_user_quota to the recharge surface (/balance + /pay)', () => {
        const html = renderToString(<DocsPage />);
        // Customer who hits the quota error should be one click from
        // either checking their balance or recharging.
        expect(html).toMatch(/href="\/balance"/);
        expect(html).toMatch(/href="\/pay"/);
    });

    it('explains that body error.code is the source of truth (not HTTP status)', () => {
        const html = renderToString(<DocsPage />);
        // Critical hint — the W7 D4 PR-H Tier B doc fallback exists
        // precisely because we haven't rewritten HTTP 403 → 402 yet.
        // Customers must read body.error.code to disambiguate.
        expect(html).toContain('error.code');
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

describe('/docs page — W10 API 契约三件套(流式契约 / 模型目录 / key 自查)', () => {
    const html = renderToString(<DocsPage />);

    it('第 09 章追加流式契约:keep-alive 注释 + 流中断错误帧 + finish_reason 标准集', () => {
        expect(html).toContain('keep-alive');
        expect(html).toContain('upstream_stream_interrupted');
        expect(html).toContain('finish_reason');
        // 标准集里的 error 语义(流中断)必须在表里
        expect(html).toContain('content_filter');
    });

    it('第 18 章 模型目录:anchor + silkroadai 字段 + 标记头 + 档次价格语义', () => {
        expect(html).toContain('id="api-models-catalog"');
        expect(html).toContain('silkroadai');
        expect(html).toContain('X-Silkroadai-Enriched');
        expect(html).toContain('input_cny_per_1m');
        expect(html).toContain('context_window');
    });

    it('第 19 章 Key 自查:anchor + 账户级余额语义 + stale + recent_used_cny', () => {
        expect(html).toContain('id="api-key-inspect"');
        expect(html).toContain('GET /v1/key');
        expect(html).toContain('account_balance');
        expect(html).toContain('stale');
        expect(html).toContain('recent_used_cny');
        expect(html).toContain('tier_display_name');
    });

    it('第 10 章速查表登记两个新端点(带章节指引)', () => {
        expect(html).toContain('GET /v1/models');
        expect(html).toContain('见第 18 章');
        expect(html).toContain('见第 19 章');
    });

    it('TOC 含两个新章节入口', () => {
        expect(html).toContain('#api-models-catalog');
        expect(html).toContain('#api-key-inspect');
        expect(html).toContain('程序化价格发现');
        expect(html).toContain('余额监控');
    });
});

describe('/docs page — 第 22 章 Batch API 批量生图(#422 OpenAI Batch 兼容)', () => {
    const html = renderToString(<DocsPage />);

    it('anchor + TOC 入口 + 第 10 章速查表登记', () => {
        expect(html).toMatch(/<section[^>]*id="api-batch"/);
        expect(html).toContain('#api-batch');
        expect(html).toContain('批量生图');
        // 第 10 章速查表新行(带章节指引)
        expect(html).toContain('/v1/files + /v1/batches');
        expect(html).toContain('见第 22 章');
    });

    it('四步流程 + 全部管理端点在场', () => {
        expect(html).toContain('POST /v1/files');
        expect(html).toContain('POST /v1/batches');
        expect(html).toContain('/content');
        expect(html).toContain('/cancel');
        expect(html).toContain('input_file_id');
        expect(html).toContain('output_file_id');
        expect(html).toContain('error_file_id');
    });

    it('JSONL 行格式四字段 + 示例模型(避开 default 组无渠道的 2.5)', () => {
        expect(html).toContain('custom_id');
        // 示例只用 default 组有渠道的两个模型(2.5 在第 12 章出现属正常,不在本章示例里)
        expect(html).toContain('gemini-3.1-flash-image-preview');
        expect(html).toContain('gpt-image-2');
        // edits 行的输入图字段说明
        expect(html).toContain('/v1/images/edits');
    });

    it('限制表:20MB / 1000 行 / 5 批 / 24h / b64_json 改写 / 同步价', () => {
        expect(html).toContain('20MB');
        expect(html).toContain('1000 行');
        expect(html).toContain('completion_window');
        expect(html).toContain('b64_json');
        expect(html).toContain('5 折');
    });

    it('状态机 + 常见错误码', () => {
        for (const s of ['validating', 'in_progress', 'expired', 'cancelled']) {
            expect(html, `status ${s}`).toContain(s);
        }
        expect(html).toContain('unsupported_endpoint');
        expect(html).toContain('batch_limit_reached');
        expect(html).toContain('duplicate_custom_id');
        expect(html).toContain('no available');
    });
});

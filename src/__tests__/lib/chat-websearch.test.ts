/**
 * Chat UI v2 — web-search layer tests.
 *
 * `buildSearchContext` is a pure renderer (empty → null; results → numbered
 * citation block). `runWebSearch` is the best-effort entry point: it must
 * return null (never throw) when no provider is configured, the query is
 * blank, or the provider errors — and return a context string on success.
 * The provider HTTP call is exercised via a mocked global fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSearchContext, runWebSearch, type WebSearchResult } from '@/lib/chat/web-search';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('buildSearchContext', () => {
    it('returns null for empty results (caller skips injection)', () => {
        expect(buildSearchContext('q', [])).toBeNull();
    });

    it('renders numbered [1]..[n] blocks with title + url + cite instruction', () => {
        const results: WebSearchResult[] = [
            { title: 'First', url: 'https://a.example', content: 'alpha' },
            { title: 'Second', url: 'https://b.example', content: 'beta' },
        ];
        const ctx = buildSearchContext('天气怎么样', results);
        expect(ctx).not.toBeNull();
        expect(ctx!).toContain('[1] First');
        expect(ctx!).toContain('[2] Second');
        expect(ctx!).toContain('https://a.example');
        expect(ctx!).toContain('https://b.example');
        expect(ctx!).toContain('天气怎么样'); // query echoed back
        expect(ctx!).toContain('[序号]'); // "cite your sources" instruction
    });
});

describe('runWebSearch', () => {
    it('returns null when no provider is configured (TAVILY_API_KEY unset)', async () => {
        vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
        vi.stubEnv('TAVILY_API_KEY', '');
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        expect(await runWebSearch('hello world')).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled(); // short-circuits before any HTTP
    });

    it('returns null for a blank query even with a provider', async () => {
        vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
        expect(await runWebSearch('   ')).toBeNull();
    });

    it('returns a context string when the provider returns results', async () => {
        vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
        vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    results: [
                        { title: 'Result One', url: 'https://x.example', content: 'body text' },
                        { title: 'Result Two', url: 'https://y.example', content: 'more text' },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );
        const ctx = await runWebSearch('news today');
        expect(ctx).not.toBeNull();
        expect(ctx!).toContain('[1] Result One');
        expect(ctx!).toContain('https://x.example');
        expect(ctx!).toContain('[2] Result Two');
    });

    it('returns null (never throws) when the provider HTTP errors', async () => {
        vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream boom', { status: 500 }));
        await expect(runWebSearch('boom')).resolves.toBeNull();
    });

    it('returns null when an unknown provider is selected', async () => {
        vi.stubEnv('WEB_SEARCH_PROVIDER', 'not-a-real-provider');
        vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
        expect(await runWebSearch('hello')).toBeNull();
    });
});

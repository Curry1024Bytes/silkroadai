/**
 * Chat UI — web search layer (MVP: inject-results, model-agnostic).
 *
 * Strategy
 * --------
 * The fastest-to-ship, model-agnostic way to add "联网搜索" is NOT a
 * tool-calling loop (which only works on tool-capable models and needs a
 * multi-turn round-trip). Instead, when the customer toggles web search
 * ON, the chat route:
 *   1. extracts the latest user query,
 *   2. calls a search provider,
 *   3. prepends a system message containing the results + a "cite your
 *      sources" instruction,
 *   4. streams the model reply as normal.
 *
 * Works on every chat model in the catalog, no per-model capability
 * detection. A proper tool-call loop can replace this later (v2) without
 * changing the customer-facing toggle.
 *
 * Provider abstraction
 * --------------------
 * `getWebSearchProvider()` returns a provider only if one is configured
 * via env. If unset, the chat route treats `web_search:true` as a no-op
 * (chat still works) — so this can ship dark and be switched on by the
 * operator setting the key. Tavily is implemented now; the interface is
 * deliberately tiny so a China-native provider (e.g. 博查/Bocha) can be
 * dropped in behind `WEB_SEARCH_PROVIDER` later.
 *
 * Server-only.
 */
import 'server-only';

export interface WebSearchResult {
    title: string;
    url: string;
    /** Snippet or extracted content; may be truncated by the provider. */
    content: string;
}

export interface WebSearchProvider {
    readonly name: string;
    search(query: string): Promise<WebSearchResult[]>;
}

const MAX_RESULTS = clampInt(process.env.WEB_SEARCH_MAX_RESULTS, 5, 1, 10);
const SEARCH_TIMEOUT_MS = 12_000;
/** Cap injected content so a verbose provider can't blow the context
 *  window / cost. Per-result content is truncated to this many chars. */
const PER_RESULT_CHARS = 1200;

function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
}

// ── Tavily provider ────────────────────────────────────────────────────

interface TavilyResponse {
    results?: Array<{ title?: string; url?: string; content?: string }>;
    error?: string;
}

class TavilyProvider implements WebSearchProvider {
    readonly name = 'tavily';
    constructor(private readonly apiKey: string) {}

    async search(query: string): Promise<WebSearchResult[]> {
        const res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: this.apiKey,
                query,
                max_results: MAX_RESULTS,
                search_depth: 'basic',
                include_answer: false,
            }),
            signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        });
        if (!res.ok) {
            throw new Error(`tavily ${res.status}`);
        }
        const body = (await res.json()) as TavilyResponse;
        return (body.results ?? [])
            .filter((r) => r.url && r.title)
            .slice(0, MAX_RESULTS)
            .map((r) => ({
                title: r.title!.trim(),
                url: r.url!.trim(),
                content: (r.content ?? '').trim().slice(0, PER_RESULT_CHARS),
            }));
    }
}

// ── Factory + context builder ──────────────────────────────────────────

/** Returns a configured provider, or null if web search isn't set up.
 *  Selection: WEB_SEARCH_PROVIDER (default 'tavily'). Add new providers
 *  here as `case` arms. */
export function getWebSearchProvider(): WebSearchProvider | null {
    const which = (process.env.WEB_SEARCH_PROVIDER || 'tavily').toLowerCase();
    switch (which) {
        case 'tavily': {
            const key = process.env.TAVILY_API_KEY;
            return key ? new TavilyProvider(key) : null;
        }
        // case 'bocha': return process.env.BOCHA_API_KEY ? new BochaProvider(...) : null;
        default:
            return null;
    }
}

/** Render results into a system-message string the model can ground on.
 *  Returns null when there are no usable results (caller skips injection). */
export function buildSearchContext(query: string, results: WebSearchResult[]): string | null {
    if (results.length === 0) return null;
    const today = new Date().toISOString().slice(0, 10);
    const blocks = results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}`).join('\n\n');
    return [
        `你可以参考以下联网搜索结果回答用户问题(检索词:「${query}」,当前日期 ${today})。`,
        `请基于这些结果作答,并在引用具体信息时用 [序号] 标注来源;若搜索结果不足以回答,请如实说明。`,
        '',
        '搜索结果:',
        blocks,
    ].join('\n');
}

/** Run a search and return the system-context string, or null on any
 *  failure / empty result. Never throws — web search is best-effort and
 *  must not break the chat turn. */
export async function runWebSearch(query: string): Promise<string | null> {
    const provider = getWebSearchProvider();
    if (!provider || !query.trim()) return null;
    try {
        const results = await provider.search(query.trim());
        return buildSearchContext(query.trim(), results);
    } catch (err) {
        console.warn(`[web-search] ${provider.name} failed:`, err);
        return null;
    }
}

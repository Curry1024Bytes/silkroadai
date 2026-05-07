/**
 * W6 D3 — /models page + ModelsBrowser SSR smoke.
 *
 * Same shallow renderToString pattern as W4-1 D2 pay-form / W6 D2
 * balance-alert-form tests. Mocks listAvailableModels at the boundary
 * so the page is deterministic without hitting new-api.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockListAvailableModels = vi.fn();
vi.mock('@/lib/newapi/client', async () => {
    const actual = await vi.importActual<typeof import('@/lib/newapi/client')>(
        '@/lib/newapi/client',
    );
    return {
        ...actual,
        listAvailableModels: () => mockListAvailableModels(),
    };
});

import ModelsPage from '@/app/models/page';
import { ModelsBrowser } from '@/app/models/models-browser';
import { groupModels } from '@/lib/models/categorize';

const SAMPLE = [
    'gpt-4-turbo',
    'gpt-4o',
    'gpt-4o-mini-tts',
    'dall-e-3',
    'text-embedding-3-large',
    'claude-opus-4-7',
    'claude-haiku-4-5',
    'deepseek-chat',
    'deepseek-v4-flash',
    'Qwen/Qwen2.5-72B-Instruct',
    'Qwen/Qwen2.5-VL-72B-Instruct',
    'glm-4-plus',
    'kimi-latest',
    'flux-pro-1.1',
    'BAAI/bge-large-zh-v1.5',
];

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('<ModelsPage /> SSR (W6 D3)', () => {
    it('renders header copy with totalModels + vendorCount', async () => {
        mockListAvailableModels.mockResolvedValue(SAMPLE);
        const el = await ModelsPage();
        const html = renderToString(el);
        expect(html).toContain('模型清单');
        // Total model count visible. W7 P2B added a `class="text-navy"` on
        // the <strong> for visual emphasis, so the regex tolerates an
        // optional class= attribute.
        expect(html).toMatch(/<strong[^>]*>15<\/strong>\s*个模型/);
        // ai.silkroadai.io endpoint surfaced for customer reference
        expect(html).toContain('https://ai.silkroadai.io');
    });

    it('renders all 5 type sections when each has at least one model', async () => {
        mockListAvailableModels.mockResolvedValue(SAMPLE);
        const el = await ModelsPage();
        const html = renderToString(el);
        // Type labels (Chinese) must each appear
        expect(html).toContain('对话模型');
        expect(html).toContain('视觉理解');
        expect(html).toContain('音频');
        expect(html).toContain('向量嵌入');
        expect(html).toContain('图像生成');
    });

    it('renders the search input + ai.silkroadai.io reference', async () => {
        mockListAvailableModels.mockResolvedValue(SAMPLE);
        const el = await ModelsPage();
        const html = renderToString(el);
        expect(html).toMatch(/<input[^>]*type="search"/);
        expect(html).toMatch(/placeholder="[^"]*搜索模型/);
    });

    it('renders error fallback when listAvailableModels throws', async () => {
        mockListAvailableModels.mockRejectedValue(new Error('new-api 502'));
        // Suppress console.warn from the page's catch branch
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await ModelsPage();
        const html = renderToString(el);
        expect(html).toContain('当前无法获取模型清单');
        // Header chrome still renders so the URL stays useful for marketing
        expect(html).toContain('模型清单');
        // The browser is NOT rendered in error mode
        expect(html).not.toMatch(/placeholder="[^"]*搜索模型/);
        warnSpy.mockRestore();
    });

    it('renders empty-data state with totalModels=0 (shows browser with empty grouped)', async () => {
        mockListAvailableModels.mockResolvedValue([]);
        const el = await ModelsPage();
        const html = renderToString(el);
        // Header still says 0 models (regex tolerates W7 P2B's class= on strong).
        expect(html).toMatch(/<strong[^>]*>0<\/strong>\s*个模型/);
    });
});

describe('<ModelsBrowser /> SSR (W6 D3)', () => {
    it('serializes model entries as visible card text', () => {
        const { grouped, totalModels, vendorCount } = groupModels(SAMPLE);
        const html = renderToString(
            <ModelsBrowser
                grouped={grouped}
                totalModels={totalModels}
                vendorCount={vendorCount}
            />,
        );
        // Every input model name appears somewhere in the markup
        for (const m of SAMPLE) {
            expect(html).toContain(m);
        }
        // Vendor chips appear (at least the ones in our sample)
        expect(html).toContain('OpenAI');
        expect(html).toContain('Anthropic');
        expect(html).toContain('DeepSeek');
        expect(html).toContain('Qwen');
        expect(html).toContain('Zhipu');
        expect(html).toContain('Moonshot');
        expect(html).toContain('Black Forest Labs');
    });

    it('renders the 复制 button per model card', () => {
        const { grouped, totalModels, vendorCount } = groupModels(['gpt-4', 'claude-opus-4-7']);
        const html = renderToString(
            <ModelsBrowser
                grouped={grouped}
                totalModels={totalModels}
                vendorCount={vendorCount}
            />,
        );
        const copyBtns = html.match(/复制/g) ?? [];
        // Two cards → ≥ 2 copy-button surfaces (button text + aria-label)
        expect(copyBtns.length).toBeGreaterThanOrEqual(2);
    });

    it('totalModels + vendorCount render in the summary line on initial paint (no debounced query yet)', () => {
        const { grouped, totalModels, vendorCount } = groupModels(SAMPLE);
        const html = renderToString(
            <ModelsBrowser
                grouped={grouped}
                totalModels={totalModels}
                vendorCount={vendorCount}
            />,
        );
        // W7 P2B: <strong> tags now carry class="text-navy"; regex tolerates
        // an optional class= attribute. Non-greedy [^>]* avoids spanning
        // across multiple tags.
        expect(html).toMatch(new RegExp(`<strong[^>]*>${totalModels}</strong>`));
        expect(html).toMatch(new RegExp(`<strong[^>]*>${vendorCount}</strong>`));
        // SSR pass shouldn't emit the "filter results" copy because
        // debouncedQuery state is initialized to ''
        expect(html).not.toContain('筛选结果');
    });
});

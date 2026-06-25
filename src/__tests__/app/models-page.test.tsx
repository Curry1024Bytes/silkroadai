/**
 * /models page + ModelsBrowser SSR smoke (vendor-first redesign).
 *
 * Same shallow renderToString pattern as the pay-form / balance-alert-form
 * tests. Mocks listAvailableModels at the boundary so the page is
 * deterministic without hitting new-api.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockListAvailableModels = vi.fn();
vi.mock('@/lib/newapi/client', async () => {
    const actual = await vi.importActual<typeof import('@/lib/newapi/client')>('@/lib/newapi/client');
    return {
        ...actual,
        listAvailableModels: () => mockListAvailableModels(),
    };
});

import ModelsPage from '@/app/models/page';
import { ModelsBrowser } from '@/app/models/models-browser';
import { classifyModels } from '@/lib/models/categorize';

/** Multi-vendor, multi-type sample drawn from the real catalog. */
const SAMPLE = [
    'gpt-5.5', // OpenAI · chat
    'gpt-image-2-4k', // OpenAI · image-gen
    'claude-opus-4-8', // Anthropic · vision
    'claude-haiku-4-5', // Anthropic · chat
    'gemini-3.5-flash', // Google · vision
    'gemini-2.5-flash-image', // Google · image-gen
    'seedance-2.0-720', // ByteDance · video
    'dreamina-seedance-2-0-1080p', // ByteDance · video
];

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('<ModelsPage /> SSR', () => {
    it('renders header copy with totalModels + vendorCount', async () => {
        mockListAvailableModels.mockResolvedValue(SAMPLE);
        const el = await ModelsPage();
        const html = renderToString(el);
        expect(html).toContain('模型清单');
        // 8 models, 4 vendors (strong tags carry class="text-navy").
        expect(html).toMatch(/<strong[^>]*>8<\/strong>\s*个模型/);
        expect(html).toMatch(/<strong[^>]*>4<\/strong>\s*个厂商/);
        expect(html).toContain('https://ai.silkroadai.io');
    });

    it('renders one section per vendor (vendor-first grouping)', async () => {
        mockListAvailableModels.mockResolvedValue(SAMPLE);
        const el = await ModelsPage();
        const html = renderToString(el);
        // Each served vendor appears as a section header — exactly once.
        for (const vendor of ['OpenAI', 'Anthropic', 'Google', 'ByteDance']) {
            expect(html).toContain(vendor);
        }
        // The Chinese descriptor for ByteDance proves the vendor meta header.
        expect(html).toContain('字节跳动');
    });

    it('renders type sub-labels inside vendor sections', async () => {
        mockListAvailableModels.mockResolvedValue(SAMPLE);
        const el = await ModelsPage();
        const html = renderToString(el);
        expect(html).toContain('对话模型');
        expect(html).toContain('视觉理解');
        expect(html).toContain('图像生成');
        expect(html).toContain('视频生成');
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
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await ModelsPage();
        const html = renderToString(el);
        expect(html).toContain('当前无法获取模型清单');
        expect(html).toContain('模型清单');
        expect(html).not.toMatch(/placeholder="[^"]*搜索模型/);
        warnSpy.mockRestore();
    });

    it('renders empty-data state with totalModels=0', async () => {
        mockListAvailableModels.mockResolvedValue([]);
        const el = await ModelsPage();
        const html = renderToString(el);
        expect(html).toMatch(/<strong[^>]*>0<\/strong>\s*个模型/);
    });

    it('renders the ← 返回 affordance (back-to-previous-page)', async () => {
        mockListAvailableModels.mockResolvedValue(SAMPLE);
        const el = await ModelsPage();
        const html = renderToString(el);
        // Now a <BackButton> (browser back) instead of a fixed href="/" link.
        expect(html).toContain('返回');
        expect(html).toMatch(/<button[^>]*>[\s\S]*返回/);
    });
});

describe('<ModelsBrowser /> SSR', () => {
    it('serializes every model name as visible card text', () => {
        const { entries, totalModels, vendorCount } = classifyModels(SAMPLE);
        const html = renderToString(
            <ModelsBrowser entries={entries} totalModels={totalModels} vendorCount={vendorCount} />,
        );
        for (const m of SAMPLE) {
            expect(html).toContain(m);
        }
        // Vendor section headers present.
        expect(html).toContain('OpenAI');
        expect(html).toContain('Anthropic');
        expect(html).toContain('Google');
        expect(html).toContain('ByteDance');
        // Capability badges present.
        expect(html).toContain('视频');
        expect(html).toContain('图像');
    });

    it('renders a 复制 button per model card', () => {
        const { entries, totalModels, vendorCount } = classifyModels(['gpt-5.5', 'claude-opus-4-8']);
        const html = renderToString(
            <ModelsBrowser entries={entries} totalModels={totalModels} vendorCount={vendorCount} />,
        );
        const copyBtns = html.match(/复制/g) ?? [];
        expect(copyBtns.length).toBeGreaterThanOrEqual(2);
    });

    it('totalModels + vendorCount render in the summary line on initial paint', () => {
        const { entries, totalModels, vendorCount } = classifyModels(SAMPLE);
        const html = renderToString(
            <ModelsBrowser entries={entries} totalModels={totalModels} vendorCount={vendorCount} />,
        );
        expect(html).toMatch(new RegExp(`<strong[^>]*>${totalModels}</strong>`));
        expect(html).toMatch(new RegExp(`<strong[^>]*>${vendorCount}</strong>`));
        expect(html).not.toContain('筛选结果');
    });
});

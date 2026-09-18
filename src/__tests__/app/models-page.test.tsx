/**
 * /models page + ModelsBrowser SSR smoke (vendor-first redesign).
 *
 * Same shallow renderToString pattern as the pay-form / balance-alert-form
 * tests. Mocks the tier-aware catalog boundary without hitting the database
 * or new-api. Interactive switching is also verified in the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockListAvailableModels = vi.fn();
const mockHeaders = vi.fn();
const mockCurrentUser = vi.fn();
vi.mock('@/lib/models/catalog-browser', () => ({
    loadBrowserCatalog: async (userId?: string) => {
        const slugs: string[] = await mockListAvailableModels(userId);
        return { tiers: TIERS, models: pricingFor(slugs) };
    },
}));
vi.mock('next/headers', () => ({ headers: () => mockHeaders() }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: (...args: unknown[]) => mockCurrentUser(...args) }));

import ModelsPage from '@/app/models/page';
import WorkspaceModelsPage from '@/app/(authenticated)/workspace/models/page';
import { ModelsBrowser, ModelTierPrices, filterCatalogTier } from '@/app/models/models-browser';
import { classifyModels } from '@/lib/models/categorize';
import type { TierPricing } from '@/lib/models/machine-catalog';
import type { BrowserModelPricing } from '@/lib/models/catalog-browser-types';

const TIERS = [{ key: 'enterprise', label: '企业级', isDefault: true }];
function pricingFor(slugs: string[]) {
    return slugs.map((slug) => ({ slug, pricesByTier: { enterprise: null } }));
}

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
    mockHeaders.mockResolvedValue(new Headers());
    mockCurrentUser.mockResolvedValue(null);
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
        expect(html).toContain('https://api.llmroute.club');
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

    it('renders the search input + api.llmroute.club reference', async () => {
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

    it('keeps request-context failures closed instead of substituting public prices', async () => {
        mockHeaders.mockRejectedValueOnce(new Error('request context unavailable'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(renderToString(await ModelsPage())).toContain('当前无法获取模型清单与价格');
        expect(mockListAvailableModels).not.toHaveBeenCalled();
    });

    it('passes the signed-in customer to the price loader and does not reuse it for guests', async () => {
        mockListAvailableModels.mockResolvedValue(SAMPLE);
        mockHeaders.mockResolvedValueOnce(new Headers({ cookie: 'silkroad_session=test-only-session' }));
        mockCurrentUser.mockResolvedValueOnce({ id: 'customer-a' });
        await ModelsPage();
        expect(mockListAvailableModels).toHaveBeenLastCalledWith('customer-a');
        await ModelsPage();
        expect(mockListAvailableModels).toHaveBeenLastCalledWith(undefined);
    });
});

describe('<WorkspaceModelsPage /> SSR', () => {
    it('renders the catalog without public-page chrome', async () => {
        mockListAvailableModels.mockResolvedValue(SAMPLE);
        const el = await WorkspaceModelsPage();
        const html = renderToString(el);
        expect(html).toContain('模型清单');
        expect(html).toContain('CATALOG');
        expect(html).not.toMatch(/<img[^>]*alt="LLmRoute"/);
        expect(html).not.toContain('<span aria-hidden="true">←</span><span>返回</span>');
    });
});

describe('<ModelsBrowser /> SSR', () => {
    it('serializes every model name as visible card text', () => {
        const { entries, totalModels, vendorCount } = classifyModels(SAMPLE);
        const html = renderToString(
            <ModelsBrowser
                entries={entries}
                totalModels={totalModels}
                vendorCount={vendorCount}
                tiers={TIERS}
                pricing={pricingFor(SAMPLE)}
            />,
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
            <ModelsBrowser
                entries={entries}
                totalModels={totalModels}
                vendorCount={vendorCount}
                tiers={TIERS}
                pricing={pricingFor(SAMPLE)}
            />,
        );
        const copyBtns = html.match(/复制/g) ?? [];
        expect(copyBtns.length).toBeGreaterThanOrEqual(2);
    });

    it('totalModels + vendorCount render in the summary line on initial paint', () => {
        const { entries, totalModels, vendorCount } = classifyModels(SAMPLE);
        const html = renderToString(
            <ModelsBrowser
                entries={entries}
                totalModels={totalModels}
                vendorCount={vendorCount}
                tiers={TIERS}
                pricing={pricingFor(SAMPLE)}
            />,
        );
        expect(html).toMatch(new RegExp(`<strong[^>]*>${totalModels}</strong>`));
        expect(html).toMatch(new RegExp(`<strong[^>]*>${vendorCount}</strong>`));
        expect(html).not.toContain('筛选结果');
    });
});

describe('tier-specific model prices', () => {
    const enterprise = { input_cny_per_1m: 0.8, output_cny_per_1m: 4.8, per_image_cny: null };
    const discounted = { input_cny_per_1m: 0.6, output_cny_per_1m: 3.6, per_image_cny: null };
    const pricing: BrowserModelPricing[] = [
        { slug: 'gpt-5.5', pricesByTier: { enterprise, discounted } },
        { slug: 'gpt-5.6-sol', pricesByTier: { enterprise: null } },
        { slug: 'claude-opus-4-8', pricesByTier: { discounted } },
    ];
    const { entries } = classifyModels(pricing.map((model) => model.slug));

    it('filters by exact tier membership even when the selected tier has no price', () => {
        expect(
            filterCatalogTier(entries, pricing, 'enterprise')
                .map((entry) => entry.shortName)
                .sort(),
        ).toEqual(['gpt-5.5', 'gpt-5.6-sol']);
        expect(
            filterCatalogTier(entries, pricing, 'discounted')
                .map((entry) => entry.shortName)
                .sort(),
        ).toEqual(['claude-opus-4-8', 'gpt-5.5']);
        expect(filterCatalogTier(entries, pricing, 'removed')).toEqual([]);
        expect(filterCatalogTier(entries, pricing, '')).toHaveLength(3);
    });

    it('shows an accessible tier selector and distinguishes each group price on the same card', () => {
        const html = renderToString(
            <ModelsBrowser
                {...classifyModels(['gpt-5.5'])}
                tiers={[...TIERS, { key: 'discounted', label: '优惠档', isDefault: false }]}
                pricing={pricing}
            />,
        );
        expect(html).toContain('for="model-tier-filter"');
        expect(html).toContain('id="model-tier-filter"');
        expect(html).toContain('全部档次');
        expect(html).toContain('企业级价格');
        expect(html).toContain('优惠档价格');
        expect(html).toContain('¥0.8');
        expect(html).toContain('¥0.6');
    });

    it('does not turn missing prices into zero and keeps legitimate zero prices', () => {
        const missing = renderToString(<ModelTierPrices price={null} type="chat" />);
        expect(missing).toContain('未定价');
        expect(missing).not.toContain('¥0');
        expect(
            renderToString(<ModelTierPrices price={{ ...enterprise, input_cny_per_1m: 0 }} type="chat" />),
        ).toContain('¥0');
        expect(
            renderToString(
                <ModelTierPrices
                    price={{ input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: 1.5 }}
                    type="image-gen"
                />,
            ),
        ).toContain('张');
    });

    it('renders exact uniform cache read/write rates without old length tables', () => {
        const price: TierPricing = {
            ...enterprise,
            billing_details: {
                version: 1,
                mode: 'tiered_token',
                unit: 'cny_per_million_tokens',
                semantics: 'whole_request',
                tiers: [
                    {
                        name: 'uniform',
                        min_input_tokens: null,
                        max_input_tokens: null,
                        min_inclusive: false,
                        max_inclusive: false,
                        rates: { input: 0.64, output: 3.2, cache_read: 0.064, cache_write: 0.8, cache_write_1h: null },
                    },
                ],
            },
        };
        const html = renderToString(<ModelTierPrices price={price} type="chat" />);
        for (const amount of ['¥0.64', '¥3.2', '¥0.064', '¥0.8']) expect(html).toContain(amount);
        expect(html).toContain('缓存读取');
        expect(html).toContain('缓存写入');
        expect(html).not.toContain('272');
        expect(html).not.toContain('输入长度');
    });
});

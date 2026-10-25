import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ModelsBrowser, ModelTierPrices, filterCatalogTier } from '@/app/models/models-browser';
import { ModelPriceDialog } from '@/app/models/model-prices';
import { classifyModels } from '@/lib/models/categorize';
import type { TierPricing } from '@/lib/models/machine-catalog';
import type { BrowserModelPricing } from '@/lib/models/catalog-browser-types';
const TIERS = [{ key: 'enterprise', label: '企业级', isDefault: true }];
function pricingFor(slugs: string[]) {
    return slugs.map((slug) => ({ slug, pricesByTier: { enterprise: null } }));
}
const SAMPLE = [
    'gpt-5.5',
    'gpt-image-2-4k',
    'claude-opus-4-8',
    'claude-haiku-4-5',
    'gemini-3.5-flash',
    'gemini-2.5-flash-image',
    'seedance-2.0-720',
    'dreamina-seedance-2-0-1080p',
];
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

    it('shows one named default tariff on the card and retains both exact group prices in details', () => {
        const tiers = [...TIERS, { key: 'discounted', label: '优惠档', isDefault: false }];
        const html = renderToString(<ModelsBrowser {...classifyModels(['gpt-5.5'])} tiers={tiers} pricing={pricing} />);
        expect(html).toContain('for="model-tier-filter"');
        expect(html).toContain('id="model-tier-filter"');
        expect(html).toContain('全部分组');
        expect(html).toContain('企业级价格摘要');
        expect(html).toContain('¥0.8');
        expect(html).not.toContain('¥0.6');
        expect(html).toContain('2 个可用分组');
        const detail = renderToString(
            <ModelPriceDialog
                entry={classifyModels(['gpt-5.5']).entries[0]}
                tiers={tiers}
                prices={pricing[0].pricesByTier}
                onClose={() => {}}
            />,
        );
        expect(detail).toContain('企业级价格');
        expect(detail).toContain('优惠档价格');
        expect(detail).toContain('¥0.8');
        expect(detail).toContain('¥0.6');
        const filteredDetail = renderToString(
            <ModelPriceDialog
                entry={classifyModels(['gpt-5.5']).entries[0]}
                tiers={TIERS}
                prices={pricing[0].pricesByTier}
                onClose={() => {}}
            />,
        );
        expect(filteredDetail).not.toContain('优惠档');
        expect(filteredDetail).not.toContain('¥0.6');
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

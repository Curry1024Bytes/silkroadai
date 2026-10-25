import { describe, expect, it, vi } from 'vitest';
// Canvas rendering is verified in the browser; keep real pricing components in this Node test.
vi.mock('@visactor/react-vchart', () => ({ VChart: () => null }));
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PricingData, PricingModel } from '@newapi/features/pricing/types';
import { filterAndSortModels } from '@newapi/features/pricing/lib/filters';
import { usePricingData } from '@newapi/features/pricing/hooks/use-pricing-data';
import '@newapi/i18n/config';
import { ModelCard } from '@newapi/features/pricing/components/model-card';
import { ModelPriceCell } from '@newapi/features/pricing/components/model-price-cell';
import { ModelDetailsContent } from '@newapi/features/pricing/components/model-details';
import { PlazaCachedPrice, PlazaPriceDetails, PlazaPriceSummary } from '@/app/models/plaza-prices';
import { formatPlazaTokenAmount, plazaQuote } from '@/lib/models/plaza-pricing';
import type { TierPricing } from '@/lib/models/machine-catalog';

const tiers = [
    { key: 'retail', label: '标准档', isDefault: true },
    { key: 'deal', label: '优惠档', isDefault: false },
];
const regular: TierPricing = { input_cny_per_1m: 3, output_cny_per_1m: 8, per_image_cny: null };
function model(
    name = 'gpt-5.5',
    prices: Record<string, TierPricing | null> = { retail: regular, deal: { ...regular, input_cny_per_1m: 0 } },
): PricingModel {
    return {
        id: 1,
        model_name: name,
        enable_groups: Object.keys(prices),
        portal: { type: 'chat', tiers, pricesByTier: prices },
    };
}
const filters = {
    search: '',
    vendor: 'all',
    group: 'all',
    quotaType: 'all',
    endpointType: 'all',
    tag: 'all',
    sortBy: 'price-low',
};

describe('model plaza exact Portal tariffs', () => {
    it('keeps small nonzero prices exact when switching to per-thousand token units', () => {
        expect(formatPlazaTokenAmount(0.000000000001, 'K')).toBe('0.000000000000001');
        expect(formatPlazaTokenAmount(1000, 'K')).toBe('1');
        expect(formatPlazaTokenAmount(0, 'K')).toBe('0');
    });
    it('uses the same exact quote in the adopted upstream card, table price cell and details', () => {
        const client = new QueryClient();
        const value = model();
        const card = renderToString(
            <QueryClientProvider client={client}>
                <ModelCard model={value} selectedGroup="deal" onClick={() => {}} />
            </QueryClientProvider>,
        );
        const cell = renderToString(<ModelPriceCell model={value} options={{ selectedGroup: 'deal' }} />);
        const details = renderToString(
            <QueryClientProvider client={client}>
                <ModelDetailsContent
                    model={value}
                    selectedGroup="deal"
                    groupRatio={{}}
                    usableGroup={{}}
                    endpointMap={{}}
                    autoGroups={[]}
                    priceRate={7}
                    usdExchangeRate={7}
                    tokenUnit="M"
                />
            </QueryClientProvider>,
        );
        for (const html of [card, cell, details]) {
            expect(html).toContain('¥0');
            expect(html).toContain('优惠档');
            expect(html).not.toContain('¥3');
        }
        client.clear();
    });

    it('uses a named default tariff instead of the lowest group price; selection is exact', () => {
        const value = model();
        expect(plazaQuote(value)?.tier?.key).toBe('retail');
        const card = renderToString(<PlazaPriceSummary model={value} />);
        expect(card).toContain('标准档');
        expect(card).toContain('¥3');
        expect(card).not.toContain('优惠档');
        const selected = renderToString(<PlazaPriceSummary model={value} selectedGroup="deal" />);
        expect(selected).toContain('优惠档');
        expect(selected).toContain('¥0');
        expect(selected).not.toContain('¥3');
        expect(renderToString(<PlazaPriceDetails model={value} selectedGroup="deal" />)).toContain('¥0');
    });
    it('retains exact membership with missing prices and never falls back for an unknown group', () => {
        const value = model('gpt-5.5', { retail: null, deal: regular });
        expect(renderToString(<PlazaPriceSummary model={value} />)).toContain('未定价');
        expect(renderToString(<PlazaPriceSummary model={value} selectedGroup="unknown" />)).not.toContain('¥');
        expect(filterAndSortModels([value], { ...filters, group: 'retail' })).toHaveLength(1);
        expect(filterAndSortModels([value], { ...filters, group: 'unknown' })).toEqual([]);
    });
    it('sorts using the selected group quote while keeping missing prices last in both directions', () => {
        const a = model('a', { retail: regular, deal: { ...regular, input_cny_per_1m: 1 } });
        const b = model('b', {
            retail: { ...regular, input_cny_per_1m: 1 },
            deal: { ...regular, input_cny_per_1m: 4 },
        });
        const missing = model('missing', { retail: null, deal: null });
        expect(filterAndSortModels([a, missing, b], filters).map((row) => row.model_name)).toEqual([
            'b',
            'a',
            'missing',
        ]);
        expect(
            filterAndSortModels([a, missing, b], { ...filters, group: 'deal' }).map((row) => row.model_name),
        ).toEqual(['a', 'b', 'missing']);
        expect(
            filterAndSortModels([a, missing, b], { ...filters, group: 'deal', sortBy: 'price-high' }).map(
                (row) => row.model_name,
            ),
        ).toEqual(['b', 'a', 'missing']);
    });
    it('retains both token tiers, strict boundaries, cache reads and 5-minute/1-hour writes', () => {
        const price: TierPricing = {
            ...regular,
            billing_details: {
                version: 1,
                mode: 'tiered_token',
                unit: 'cny_per_million_tokens',
                semantics: 'whole_request',
                tiers: [
                    {
                        name: 'short',
                        min_input_tokens: null,
                        max_input_tokens: 272000,
                        min_inclusive: false,
                        max_inclusive: true,
                        rates: { input: 0, output: 8, cache_read: 0, cache_write: 0.5, cache_write_1h: 1.2 },
                    },
                    {
                        name: 'long',
                        min_input_tokens: 272000,
                        max_input_tokens: null,
                        min_inclusive: false,
                        max_inclusive: false,
                        rates: { input: 6, output: 12, cache_read: 0.4, cache_write: 1, cache_write_1h: 2.4 },
                    },
                ],
            },
        };
        const value = model('gpt-5.5', { retail: price });
        const details = renderToString(<PlazaPriceDetails model={value} />);
        for (const text of ['≤ 272,000', '&gt; 272,000', '¥0', '¥6', '¥2.4', '缓存读取', '5 分钟', '1 小时'])
            expect(details).toContain(text);
        const cached = renderToString(<PlazaCachedPrice model={value} />);
        expect(cached).toContain('¥0');
        expect(cached).toContain('≤ 272,000');
        const summary = renderToString(<PlazaPriceSummary model={value} tokenUnit="K" />);
        expect(summary).toContain('元 / 千 token');
        expect(summary).toContain('¥0.008');
    });
    it.each([
        ['cny_per_image', '张'],
        ['cny_per_second', '秒'],
        ['cny_per_request', '次'],
    ] as const)('retains %s specifications and cross-midnight conditions', (unit, label) => {
        const price: TierPricing = {
            ...regular,
            billing_details: {
                version: 1,
                mode: 'media',
                unit,
                default_price: null,
                resolution_prices: { '720p': 1, '1080p': 1.5 },
                scheduled_discount: { start: '22:00', end: '08:00', timezone: 'Asia/Shanghai', multiplier: 0.5 },
            },
        };
        const value = model('seedance-2.0', { retail: price });
        const html = renderToString(<PlazaPriceDetails model={value} />);
        for (const text of ['720p', '1080p', '¥1.5', '22:00', '08:00', '北京时间', label]) expect(html).toContain(text);
        expect(renderToString(<PlazaPriceSummary model={value} />)).toContain('常规价 · 720p');
    });
    it('keeps image token components distinct from per-image prices', () => {
        const price: TierPricing = {
            ...regular,
            billing_details: {
                version: 1,
                mode: 'component_token',
                unit: 'cny_per_million_tokens',
                rates: { input: 5, output: 30, cache_read: 0.5, image_input: 10, image_cache_read: 1 },
            },
        };
        const value = model('gpt-image-2', { retail: price });
        const detail = renderToString(<PlazaPriceDetails model={value} />);
        for (const text of ['文本输入', '图片输入', '图片缓存读取', '¥10', '百万 token'])
            expect(detail).toContain(text);
    });
    it('hides a previously loaded quote after a background read error', async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const data: PricingData = {
            success: true,
            data: [model()],
            vendors: [],
            group_ratio: {},
            usable_group: {},
            supported_endpoint: {},
            auto_groups: [],
            portal_viewer_key: 'customer-a',
            portal_tiers: tiers,
        };
        const key = ['pricing', 'customer-a'];
        client.setQueryData(key, data);
        await client
            .fetchQuery({ queryKey: key, queryFn: () => Promise.reject(new Error('price unavailable')) })
            .catch(() => {});
        function Snapshot() {
            const state = usePricingData(data);
            return (
                <span>
                    {state.error ? 'unavailable' : 'ready'}:{state.models.length}
                </span>
            );
        }
        expect(
            renderToString(
                <QueryClientProvider client={client}>
                    <Snapshot />
                </QueryClientProvider>,
            ),
        ).toContain('unavailable<!-- -->:<!-- -->0');
        client.clear();
    });
});

import { describe, expect, it } from 'vitest';
import { catalogPriceSummary, catalogSummaryTier } from '../catalog-price-summary';
import type { TierPricing } from '../machine-catalog';
import type { CatalogBillingDetails } from '../catalog-pricing-details';

const price = (billing_details?: CatalogBillingDetails): TierPricing => ({
    input_cny_per_1m: 999,
    output_cny_per_1m: 999,
    per_image_cny: null,
    billing_details,
});

describe('catalog card price summary', () => {
    it('uses the default membership without inventing a lowest price or substituting another group for a missing tariff', () => {
        const tiers = [
            { key: 'cheap', label: '优惠', isDefault: false },
            { key: 'default', label: '默认', isDefault: true },
        ];
        expect(catalogSummaryTier(tiers, { cheap: price(), default: null })?.key).toBe('default');
        expect(catalogSummaryTier(tiers, { cheap: price() })?.key).toBe('cheap');
        expect(catalogSummaryTier([tiers[0]], { default: price() })).toBeUndefined();
    });

    it('distinguishes missing prices from zero, including a free media default', () => {
        expect(catalogPriceSummary(null, 'chat')).toBeNull();
        expect(
            catalogPriceSummary({ input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: null }, 'chat'),
        ).toBeNull();
        expect(
            catalogPriceSummary({ input_cny_per_1m: 0, output_cny_per_1m: 1, per_image_cny: null }, 'chat')?.rates[0]
                .amount,
        ).toBe(0);
        const summary = catalogPriceSummary(
            price({
                version: 1,
                mode: 'media',
                unit: 'cny_per_image',
                default_price: 0,
                resolution_prices: { '4K': 2 },
            }),
            'image-gen',
        );
        expect(summary).toMatchObject({ unit: '元 / 张', rates: [{ amount: 0 }], condition: '默认规格' });
    });

    it.each([false, true])('preserves the first input-length condition, including max_inclusive=%s', (inclusive) => {
        const details: CatalogBillingDetails = {
            version: 1,
            mode: 'tiered_token',
            unit: 'cny_per_million_tokens',
            semantics: 'whole_request',
            tiers: [
                {
                    name: 'base',
                    min_input_tokens: null,
                    max_input_tokens: 272000,
                    min_inclusive: false,
                    max_inclusive: inclusive,
                    rates: { input: 0.6, output: 3.6, cache_read: 0.06, cache_write: 0.75, cache_write_1h: null },
                },
                {
                    name: 'long',
                    min_input_tokens: 272000,
                    max_input_tokens: null,
                    min_inclusive: !inclusive,
                    max_inclusive: false,
                    rates: { input: 1.2, output: 5.4, cache_read: 0.12, cache_write: 1.5, cache_write_1h: null },
                },
            ],
        };
        const summary = catalogPriceSummary(price(details), 'chat');
        expect(summary?.rates).toEqual([
            { label: '输入', amount: 0.6 },
            { label: '输出', amount: 3.6 },
        ]);
        expect(summary?.condition).toBe(`完整输入 token ${inclusive ? '≤' : '<'} 272,000`);
        expect(summary?.unit).toBe('元 / 百万 token');
    });

    it.each([
        ['cny_per_image', '元 / 张'],
        ['cny_per_second', '元 / 秒'],
        ['cny_per_request', '元 / 次'],
    ] as const)(
        'preserves %s and labels the chosen specification instead of selecting the minimum price',
        (unit, label) => {
            const summary = catalogPriceSummary(
                price({
                    version: 1,
                    mode: 'media',
                    unit,
                    default_price: null,
                    resolution_prices: { '4K': 0.1, '2K': 1, '1K': 2 },
                }),
                'image-gen',
            );
            expect(summary).toMatchObject({ unit: label, rates: [{ amount: 2 }], condition: '1K' });
        },
    );

    it('marks a scheduled discount tariff as a regular price instead of silently assuming a time', () => {
        const summary = catalogPriceSummary(
            price({
                version: 1,
                mode: 'media',
                unit: 'cny_per_second',
                default_price: null,
                resolution_prices: { '1080p': 1.5, '720p': 1 },
                scheduled_discount: { start: '22:00', end: '08:00', timezone: 'Asia/Shanghai', multiplier: 0.5 },
            }),
            'video',
        );
        expect(summary).toMatchObject({
            condition: '常规价 · 720p',
            rates: [{ amount: 1 }],
            note: '分时优惠与完整规格见详情',
        });
    });

    it('keeps image component pricing in token units with an explicit image-input qualification', () => {
        const summary = catalogPriceSummary(
            price({
                version: 1,
                mode: 'component_token',
                unit: 'cny_per_million_tokens',
                rates: { input: 5, output: 30, cache_read: 0.5, image_input: 10, image_cache_read: 1 },
            }),
            'image-gen',
        );
        expect(summary).toMatchObject({
            unit: '元 / 百万 token',
            rates: [
                { label: '文本输入', amount: 5 },
                { label: '输出', amount: 30 },
            ],
            condition: '图片输入另计，完整价格见详情',
        });
    });
});

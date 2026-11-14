import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TieredPricingDetails } from '@/lib/admin/pricing-publish-types';
import { BASE_FX } from '@/lib/admin/pricing-simple-core';
import { computeVideoQuote, videoQuoteCostConfig } from '@/lib/admin/pricing-video-quote';
import { VIDEO_TOKEN_COMBOS } from '@/lib/admin/pricing-video-token-expression';

const mockModels = vi.fn();
const mockGroups = vi.fn();
const mockCostRules = vi.fn();
const mockMultipliers = vi.fn();
const mockGetOption = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        catalogModel: { findMany: (...args: unknown[]) => mockModels(...args) },
        channelGroup: { findMany: (...args: unknown[]) => mockGroups(...args) },
        pricingCostRule: { findMany: (...args: unknown[]) => mockCostRules(...args) },
    },
}));
vi.mock('@/lib/newapi/client', () => ({ getOption: (...args: unknown[]) => mockGetOption(...args) }));
vi.mock('@/lib/newapi/user-tier-multiplier', () => ({
    listUserTierMultipliers: (...args: unknown[]) => mockMultipliers(...args),
}));

import { loadBrowserCatalog } from '../catalog-browser';

const platform = '00000000-0000-0000-0000-000000000001';
const past = new Date('2025-01-01T00:00:00Z');
const price = (tier: string, input: number | string | null = 1, output: number | null = 5) => ({
    tier,
    input_cny_per_1m: input,
    output_cny_per_1m: output,
    per_image_cny: null as number | null,
    billing_details: null as unknown,
    effective_from: past,
    cost_cny_per_1m: 0.01,
});
const group = (key: string, channel: number, extra: Record<string, unknown> = {}) => ({
    key,
    display_name: `Label ${key}`,
    newapi_group: `billing-${key}`,
    newapi_channel_ids: [channel],
    is_default: key === 'sale',
    enabled: true,
    tier_level: channel,
    tenant_id: platform,
    ...extra,
});
const model = (slug: string, upstream_map: unknown, prices = [price('sale')]) => ({
    slug,
    upstream_map,
    prices,
    tenant_id: platform,
    enabled: true,
});
const route = (channel_id: number) => ({ channel_id, upstream_model: 'internal-provider-name' });

function videoRuleFixture(groupRatio = 0.16) {
    const official = VIDEO_TOKEN_COMBOS.map((combo, index) => ({ ...combo, price: 31 + index * 3 }));
    const config = videoQuoteCostConfig({ official, buy_discount: 0.5, sell_discount: 0.75 });
    const quote = computeVideoQuote({ official, buy_discount: 0.5, sell_discount: 0.75 }, BASE_FX, groupRatio);
    const cells = quote.map(({ resolution, video_input, actual }) => ({ resolution, video_input, price: actual }));
    const slug = 'seedance2.0-pro-720p';
    const mapping = { channel_id: 1, upstream_model: 'internal-provider-name' };
    const row = {
        tier: 'sale',
        ...mapping,
        config,
        model: { slug },
    };
    const videoCatalogPrice = {
        ...price('sale', null, null),
        billing_details: {
            version: 1,
            mode: 'video_token',
            unit: 'cny_per_million_tokens',
            cells,
        },
    };
    return { slug, official, config, quote, cells, row, videoCatalogPrice };
}

/** Let adversarial fixture rows reach the loader only if its DB scope admits them. */
function catalogFixture(rows: ReturnType<typeof model>[], groups = [group('sale', 1), group('premium', 2)]) {
    mockModels.mockImplementation(async (query) =>
        rows
            .filter((row) => row.tenant_id === query.where.tenant_id && row.enabled === query.where.enabled)
            .map((row) => ({
                ...row,
                prices: row.prices
                    .filter((entry) => entry.effective_from <= query.select.prices.where.effective_from.lte)
                    .sort((a, b) => b.effective_from.getTime() - a.effective_from.getTime()),
            })),
    );
    mockGroups.mockImplementation(async (query) =>
        groups.filter((row) => row.tenant_id === query.where.tenant_id && row.enabled === query.where.enabled),
    );
}

const conditionalDetails: TieredPricingDetails = {
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
            max_inclusive: false,
            rates: { input: 0.8, output: 4.8, cache_read: 0.000000384, cache_write: 0, cache_write_1h: 0.32 },
        },
        {
            name: 'long',
            min_input_tokens: 272000,
            max_input_tokens: null,
            min_inclusive: true,
            max_inclusive: false,
            rates: { input: 1.6, output: 7.2, cache_read: 0.000000768, cache_write: 0, cache_write_1h: 0.64 },
        },
    ],
};

beforeEach(() => {
    vi.clearAllMocks();
    mockMultipliers.mockReset().mockResolvedValue([]);
    mockGetOption.mockReset().mockResolvedValue(JSON.stringify({ 'billing-sale': 0.16, 'billing-premium': 0.5 }));
    mockCostRules.mockReset().mockResolvedValue([]);
    catalogFixture([]);
});

describe('loadBrowserCatalog memberships and retail prices', () => {
    it('keeps resolution/second quotes visible when there is no scalar price', async () => {
        catalogFixture([
            model('video-test', { sale: route(1) }, [
                {
                    ...price('sale', null, null),
                    billing_details: {
                        version: 1,
                        mode: 'media',
                        unit: 'cny_per_second',
                        default_price: null,
                        resolution_prices: { '1080p': 1.5 },
                    },
                },
            ]),
        ]);
        const result = await loadBrowserCatalog();
        expect(result.models[0].pricesByTier.sale).toMatchObject({
            input_cny_per_1m: null,
            per_image_cny: null,
            billing_details: { unit: 'cny_per_second', resolution_prices: { '1080p': 1.5 } },
        });
    });
    it('keeps exact prices isolated for a shared slug and includes linked but unpriced tiers', async () => {
        catalogFixture([
            model('shared', { sale: route(1), premium: route(2) }, [price('sale', 1, 5), price('premium', 3, 15)]),
            model('unpriced', { sale: route(1), premium: route(2) }, [price('premium', 9, 45)]),
            model('premium-only', { premium: route(2) }, [price('sale', 0.1, 0.5), price('premium', 2, 10)]),
        ]);
        const catalog = await loadBrowserCatalog();
        expect(catalog.tiers).toEqual([
            { key: 'sale', label: 'Label sale', isDefault: true },
            { key: 'premium', label: 'Label premium', isDefault: false },
        ]);
        expect(catalog.models).toEqual([
            {
                slug: 'shared',
                pricesByTier: {
                    sale: { input_cny_per_1m: 1, output_cny_per_1m: 5, per_image_cny: null },
                    premium: { input_cny_per_1m: 3, output_cny_per_1m: 15, per_image_cny: null },
                },
            },
            {
                slug: 'unpriced',
                pricesByTier: {
                    sale: null,
                    premium: { input_cny_per_1m: 9, output_cny_per_1m: 45, per_image_cny: null },
                },
            },
            {
                slug: 'premium-only',
                pricesByTier: { premium: { input_cny_per_1m: 2, output_cny_per_1m: 10, per_image_cny: null } },
            },
        ]);
        expect(mockGetOption).not.toHaveBeenCalled();
        expect(mockMultipliers).not.toHaveBeenCalled();
    });

    it('uses only the latest effective price without allowing future or retired prices to create a tier', async () => {
        catalogFixture([
            model('shared', { sale: route(1), premium: route(2), retired: route(3) }, [
                { ...price('sale', 2, 10), effective_from: new Date('2025-03-01') },
                price('sale', 1, 5),
                { ...price('sale', 99, 99), effective_from: new Date('2099-01-01') },
                { ...price('premium', 99, 99), effective_from: new Date('2099-01-01') },
                price('retired', 0.01, 0.01),
            ]),
        ]);
        const catalog = await loadBrowserCatalog();
        expect(catalog.models[0].pricesByTier).toEqual({
            sale: { input_cny_per_1m: 2, output_cny_per_1m: 10, per_image_cny: null },
            premium: null,
        });
        expect(catalog.tiers.map((tier) => tier.key)).toEqual(['sale', 'premium']);
        const query = mockModels.mock.calls[0][0];
        expect(query.select.prices.orderBy).toEqual({ effective_from: 'desc' });
        expect(query.select.prices.where.effective_from.lte).toBeInstanceOf(Date);
    });

    it('excludes hidden, disabled, other-tenant and unmapped models and never selects cost records', async () => {
        catalogFixture(
            [
                model('visible', { sale: route(1), foreign: route(9), disabled: route(8) }),
                model('gpt-5.3-codex-spark', { sale: route(1) }),
                { ...model('disabled', { sale: route(1) }), enabled: false },
                { ...model('foreign', { sale: route(1) }), tenant_id: 'other-tenant' },
                model('unmapped', {}),
            ],
            [
                group('sale', 1),
                group('disabled', 8, { enabled: false }),
                group('foreign', 9, { tenant_id: 'other-tenant' }),
            ],
        );
        const catalog = await loadBrowserCatalog();
        expect(catalog.models.map((entry) => entry.slug)).toEqual(['visible']);
        expect(Object.keys(catalog.models[0].pricesByTier)).toEqual(['sale']);
        expect(catalog.tiers.map((entry) => entry.key)).toEqual(['sale']);
        expect(mockModels.mock.calls[0][0].where).toEqual({ tenant_id: platform, enabled: true });
        expect(mockGroups.mock.calls[0][0].where).toEqual({ tenant_id: platform, enabled: true });
        expect(mockModels.mock.calls[0][0].select.prices.select).toEqual({
            tier: true,
            input_cny_per_1m: true,
            output_cny_per_1m: true,
            per_image_cny: true,
            billing_details: true,
        });
        const payload = JSON.stringify(catalog);
        for (const internal of ['channel_id', 'upstream_model', 'billing-sale', 'cost_cny', 'tenant_id'])
            expect(payload).not.toContain(internal);
    });

    it('rejects wrong-channel and malformed memberships while preserving an independently valid tier', async () => {
        catalogFixture([
            model('wrong-owner', { sale: route(2), premium: route(2) }),
            model('unknown-channel', { sale: route(999) }),
            model('missing-name', { sale: { channel_id: 1 } }),
            model('invalid-shape', ['sale']),
            model('non-numeric-channel', { sale: { ...route(1), channel_id: '1' } }),
        ]);
        expect((await loadBrowserCatalog()).models).toEqual([{ slug: 'wrong-owner', pricesByTier: { premium: null } }]);
    });

    it.each([
        [],
        [group('sale', 1, { newapi_channel_ids: [] })],
        [group('sale', 1), group('premium', 1)],
        [group('sale', 1), group('premium', 2, { newapi_group: 'billing-sale' })],
        [group('sale', 1), group('premium', 2, { is_default: true })],
    ])('fails closed for an invalid active topology: %j', async (...groups) => {
        catalogFixture([], groups);
        await expect(loadBrowserCatalog()).rejects.toThrow('invalid channel-group topology');
    });

    it('treats a latest empty price as unpriced, preserves genuine zero prices, and supports per-image prices', async () => {
        catalogFixture([
            model('empty', { sale: route(1) }, [
                { ...price('sale', null, null), effective_from: new Date('2025-03-01') },
                price('sale', 10, 50),
            ]),
            model('free', { sale: route(1) }, [price('sale', 0, 0)]),
            model('image', { sale: route(1) }, [{ ...price('sale', null, null), per_image_cny: 0.12 }]),
        ]);
        expect((await loadBrowserCatalog()).models).toEqual([
            { slug: 'empty', pricesByTier: { sale: null } },
            {
                slug: 'free',
                pricesByTier: { sale: { input_cny_per_1m: 0, output_cny_per_1m: 0, per_image_cny: null } },
            },
            {
                slug: 'image',
                pricesByTier: { sale: { input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: 0.12 } },
            },
        ]);
    });

    it('fails closed for corrupt latest billing metadata instead of falling back to an old scalar price', async () => {
        catalogFixture([
            model('corrupt', { sale: route(1) }, [
                { ...price('sale'), billing_details: { mode: 'tiered_token' }, effective_from: new Date('2025-03-01') },
                price('sale', 10, 50),
            ]),
        ]);
        await expect(loadBrowserCatalog()).rejects.toThrow('Invalid tiered pricing details');
    });
});

describe('loadBrowserCatalog dedicated customer quotes', () => {
    const dedicatedRule = { tier_key: 'sale', newapi_billing_group: 'billing-sale', multiplier: 0.18 };

    beforeEach(() => {
        catalogFixture([
            model('shared', { sale: route(1), premium: route(2) }, [
                { ...price('sale', '0.8000', 4.8), billing_details: conditionalDetails },
                price('premium', 3, 15),
            ]),
        ]);
    });

    it('replaces the public multiplier for every conditional/cache rate without rounding away precision or zero', async () => {
        mockMultipliers.mockResolvedValue([dedicatedRule]);
        const customer = await loadBrowserCatalog('customer-a');
        expect(mockMultipliers).toHaveBeenCalledWith('customer-a');
        expect(mockGetOption).toHaveBeenCalledWith('GroupRatio');
        const quote = customer.models[0].pricesByTier.sale!;
        if (quote.billing_details?.mode !== 'tiered_token') throw new Error('Expected complete token tiers');
        expect(quote.input_cny_per_1m).toBe(0.9);
        expect(quote.output_cny_per_1m).toBe(5.4);
        expect(quote.billing_details!.tiers[0].rates).toEqual({
            input: 0.9,
            output: 5.4,
            cache_read: 0.000000432,
            cache_write: 0,
            cache_write_1h: 0.36,
        });
        expect(quote.billing_details!.tiers[1].rates.cache_read).toBe(0.000000864);
        expect(quote.billing_details!.tiers[0].max_input_tokens).toBe(272000);
        expect(quote.billing_details!.semantics).toBe('whole_request');
        expect(customer.models[0].pricesByTier.premium!.input_cny_per_1m).toBe(3);
        expect((await loadBrowserCatalog()).models[0].pricesByTier.sale!.input_cny_per_1m).toBe(0.8);
        expect(conditionalDetails.tiers[0].rates.cache_read).toBe(0.000000384);
    });

    it('keeps a dedicated zero price and scales scalar Decimal and per-image prices', async () => {
        catalogFixture([
            model('scalar', { sale: route(1) }, [price('sale', '0.0128', 0.064)]),
            model('image', { sale: route(1) }, [{ ...price('sale', null, null), per_image_cny: 0.12 }]),
        ]);
        mockMultipliers.mockResolvedValue([dedicatedRule]);
        const scaled = await loadBrowserCatalog('customer-a');
        expect(scaled.models[0].pricesByTier.sale!.input_cny_per_1m).toBe(0.0144);
        expect(scaled.models[1].pricesByTier.sale!.per_image_cny).toBe(0.135);
        mockMultipliers.mockResolvedValue([{ ...dedicatedRule, multiplier: 0 }]);
        const free = await loadBrowserCatalog('customer-a');
        expect(free.models[0].pricesByTier.sale!.input_cny_per_1m).toBe(0);
        expect(free.models[1].pricesByTier.sale!.per_image_cny).toBe(0);
    });

    it('does not call new-api for customers without current overrides and never revives retired override tiers', async () => {
        await loadBrowserCatalog('customer-a');
        mockMultipliers.mockResolvedValue([
            { tier_key: 'retired', newapi_billing_group: 'billing-retired', multiplier: 0.01 },
        ]);
        const catalog = await loadBrowserCatalog('customer-b');
        expect(mockGetOption).not.toHaveBeenCalled();
        expect(catalog.tiers.map((tier) => tier.key)).toEqual(['sale', 'premium']);
        expect(catalog.models[0].pricesByTier.sale!.input_cny_per_1m).toBe(0.8);
    });

    it.each([null, '{}', '[]', 'invalid', '{"billing-sale":0}', '{"billing-sale":-1}', '{"billing-sale":"0.16"}'])(
        'fails closed when the public denominator is unverifiable: %s',
        async (raw) => {
            mockMultipliers.mockResolvedValue([dedicatedRule]);
            mockGetOption.mockResolvedValue(raw);
            await expect(loadBrowserCatalog('customer-a')).rejects.toThrow();
        },
    );

    it.each([
        [dedicatedRule, dedicatedRule],
        [{ ...dedicatedRule, tier_key: 'premium' }],
        [{ ...dedicatedRule, newapi_billing_group: 'retired' }],
        [{ ...dedicatedRule, tier_key: 'retired' }],
        [{ ...dedicatedRule, multiplier: -1 }],
    ])('fails closed for ambiguous or misaligned customer overrides: %j', async (...overrides) => {
        mockMultipliers.mockResolvedValue(overrides);
        await expect(loadBrowserCatalog('customer-a')).rejects.toThrow('Cannot verify dedicated customer price');
    });

    it('propagates customer lookup and multiplier verification failures rather than returning public prices', async () => {
        mockMultipliers.mockRejectedValueOnce(new Error('customer lookup unavailable'));
        await expect(loadBrowserCatalog('customer-a')).rejects.toThrow('customer lookup unavailable');
        mockMultipliers.mockResolvedValue([dedicatedRule]);
        mockGetOption.mockRejectedValue(new Error('upstream unavailable'));
        await expect(loadBrowserCatalog('customer-a')).rejects.toThrow('upstream unavailable');
    });
});

describe('loadBrowserCatalog Seedance price provenance', () => {
    function seedanceFixture() {
        const fixture = videoRuleFixture();
        catalogFixture([model(fixture.slug, { sale: route(1) }, [fixture.videoCatalogPrice])]);
        mockCostRules.mockResolvedValue([fixture.row]);
        mockGetOption.mockResolvedValue(JSON.stringify({ 'billing-sale': 0.16 }));
        return fixture;
    }

    it('shows the configured 75折 marker only when the full live quote matches', async () => {
        seedanceFixture();
        const catalog = await loadBrowserCatalog();
        const pricing = catalog.models[0].pricesByTier.sale!;
        expect(pricing.price_provenance).toMatchObject({
            source: 'pricing_cost_rule',
            discount: 0.75,
            verifiable: true,
        });
        expect(pricing.billing_details?.mode).toBe('video_token');
    });

    it('hides the unsupported 4K display cell for Seedance 2.5 while retaining it for Seedance 2.0', async () => {
        const fixture = videoRuleFixture();
        const seedance25Slug = 'doubao-seedance-2-5-260628';
        const seedance25Price = {
            ...fixture.videoCatalogPrice,
            billing_details: {
                ...fixture.videoCatalogPrice.billing_details,
                cells: fixture.videoCatalogPrice.billing_details.cells.map((cell) => ({ ...cell })),
            },
        };
        catalogFixture([
            model(fixture.slug, { sale: route(1) }, [fixture.videoCatalogPrice]),
            model(seedance25Slug, { sale: route(1) }, [seedance25Price]),
        ]);

        const catalog = await loadBrowserCatalog();
        const seedance20 = catalog.models.find((entry) => entry.slug === fixture.slug)!.pricesByTier.sale!;
        const seedance25 = catalog.models.find((entry) => entry.slug === seedance25Slug)!.pricesByTier.sale!;
        const cells20 = seedance20.billing_details?.mode === 'video_token' ? seedance20.billing_details.cells : [];
        const cells25 = seedance25.billing_details?.mode === 'video_token' ? seedance25.billing_details.cells : [];

        expect(cells20).toHaveLength(8);
        expect(cells20.some((cell) => cell.resolution === '4k')).toBe(true);
        expect(cells25).toHaveLength(6);
        expect(cells25.some((cell) => cell.resolution === '4k')).toBe(false);
        expect(seedance25Price.billing_details.cells).toHaveLength(8);
    });

    it('scales customer prices once while retaining the standard sale discount provenance', async () => {
        seedanceFixture();
        mockMultipliers.mockResolvedValue([
            { tier_key: 'sale', newapi_billing_group: 'billing-sale', multiplier: 0.08 },
        ]);
        const catalog = await loadBrowserCatalog('customer-a');
        const pricing = catalog.models[0].pricesByTier.sale!;
        expect(pricing.price_provenance).toMatchObject({ discount: 0.75, verifiable: true });
        const cells = pricing.billing_details?.mode === 'video_token' ? pricing.billing_details.cells : [];
        expect(cells[0].price).toBeCloseTo(videoRuleFixture().quote[0].actual * 0.5);
    });

    it.each([
        ['missing cost rule', () => mockCostRules.mockResolvedValue([])],
        ['stale mapping', () => mockCostRules.mockResolvedValue([{ ...videoRuleFixture().row, channel_id: 2 }])],
        ['wrong GroupRatio', () => mockGetOption.mockResolvedValue(JSON.stringify({ 'billing-sale': 0.2 }))],
        [
            'catalog price drift',
            () => {
                const fixture = videoRuleFixture();
                const cells = [...fixture.videoCatalogPrice.billing_details.cells];
                cells[0] = { ...cells[0], price: cells[0].price + 0.01 };
                catalogFixture([
                    model(fixture.slug, { sale: route(1) }, [
                        {
                            ...fixture.videoCatalogPrice,
                            billing_details: { ...fixture.videoCatalogPrice.billing_details, cells },
                        },
                    ]),
                ]);
                mockCostRules.mockResolvedValue([fixture.row]);
            },
        ],
    ])('hides the marker for %s', async (_label, mutate) => {
        seedanceFixture();
        mutate();
        const pricing = (await loadBrowserCatalog()).models[0].pricesByTier.sale!;
        expect(pricing).not.toHaveProperty('price_provenance');
    });

    it('hides the marker for scheduled discounts', async () => {
        const fixture = seedanceFixture();
        catalogFixture([
            model(fixture.slug, { sale: route(1) }, [
                {
                    ...fixture.videoCatalogPrice,
                    billing_details: {
                        ...fixture.videoCatalogPrice.billing_details,
                        scheduled_discount: {
                            start: '00:00',
                            end: '08:00',
                            timezone: 'Asia/Shanghai',
                            multiplier: 0.75,
                        },
                    },
                },
            ]),
        ]);
        expect((await loadBrowserCatalog()).models[0].pricesByTier.sale!).not.toHaveProperty('price_provenance');
    });
});

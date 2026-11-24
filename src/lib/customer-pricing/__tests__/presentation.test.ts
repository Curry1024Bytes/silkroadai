import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficialContext } from '../context';

const m = vi.hoisted(() => ({ rules: vi.fn(), count: vi.fn(), bindings: vi.fn(), context: vi.fn() }));
vi.mock('@/lib/db', () => ({
    prisma: {
        customerOfficialPriceRule: { findMany: m.rules, count: m.count },
        customerPricingBinding: { findMany: m.bindings },
    },
}));
vi.mock('../context', () => ({ loadOfficialContext: m.context }));
vi.mock('@/lib/newapi/quota-units', () => ({ QUOTA_PER_USD: 500000, USD_TO_CNY_RATE: 1 }));

import { loadCustomerOfficialQuotes, summarizeCustomerOfficialTiers } from '../presentation';

function context(): OfficialContext {
    const official = [100, 200, 10, 125, 200, 250];
    const base = [30, 60, 3, 37.5, 60, 75];
    const keys = ['input', 'output', 'cache_read', 'cache_write', 'cache_write_1h', 'cache_write_12h'];
    return {
        version: 'v1',
        user: {
            id: 'customer-a',
            tenant_id: 'tenant-a',
            newapi_user_id: 7,
            newapi_access_token: 'private-customer-auth',
        },
        rules: [{ id: 'rule-a', tier_key: 'sd', model_id: null, official_multiplier: 0.2, revision: 1 }],
        channels: [],
        bindings: [
            {
                id: 'binding-a',
                user_id: 'customer-a',
                tier_key: 'sd',
                public_group: 'SD官转',
                model_groups: [],
                token_snapshots: [],
                original_user_group: 'default',
                original_auto_permissions: {},
                status: 'active',
                revision: 1,
                created_at: new Date('2026-11-19T04:00:00Z'),
                updated_at: new Date('2026-11-19T04:00:00Z'),
            },
        ],
        registry: [],
        model_states: {},
        options: {
            ModelPrice: {},
            ModelRatio: { 'model-a': 15 },
            CompletionRatio: { 'model-a': 2 },
            CacheRatio: { 'model-a': 0.1 },
            CreateCacheRatio: { 'model-a': 1.25 },
        },
        tiers: [
            {
                key: 'sd',
                display_name: 'SD官转',
                public_group: 'SD官转',
                public_ratio: 1,
                legacy_multiplier: null,
                binding_status: 'active',
                models: [
                    {
                        model_id: 'model-a',
                        model_name: 'model-a',
                        display_name: 'Model A',
                        tier_key: 'sd',
                        public_group: 'SD官转',
                        public_ratio: 1,
                        current_ratio: 0.666666666667,
                        source_channel_ids: [13],
                        reference_revision: 'reference:1',
                        reference_source: '已确认官方价',
                        reference_available: true,
                        unavailable_reason: null,
                        shape: 'token',
                        public_official_multiplier: 0.3,
                        current_official_multiplier: 0.2,
                        current_rule_scope: 'tier',
                        cells: official.map((amount, index) => ({
                            key: `0:${keys[index]}`,
                            label: keys[index],
                            unit: 'million_tokens',
                            official_cny: amount,
                            public_cny: base[index],
                            base_cny: base[index],
                            cost_cny: amount * 0.1,
                        })),
                    },
                ],
            },
        ],
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    m.rules.mockResolvedValue([{ id: 'rule-a', tier_key: 'sd', model_key: '*', official_multiplier: 0.2 }]);
    m.count.mockResolvedValue(1);
    m.bindings.mockResolvedValue([{ tier_key: 'sd', status: 'active' }]);
    m.context.mockImplementation(async () => context());
});

describe('verified customer official-price presentation', () => {
    it('displays the actual verified native price, with an absolute official multiplier and no purchasing data', async () => {
        const quotes = await loadCustomerOfficialQuotes('customer-a');
        expect(m.context).toHaveBeenCalledWith('customer-a');
        const price = quotes.get('model-a\u0000sd')!;
        expect(price.input_cny_per_1m).toBe(20);
        expect(price.output_cny_per_1m).toBe(40);
        expect(price.customer_pricing).toEqual({
            basis: 'official',
            multiplier: 0.2,
            scope: 'tier',
            public_official_multiplier: 0.3,
            official_multiplier: 0.2,
        });
        expect(JSON.stringify([...quotes])).not.toContain('cost_cny');
        expect(JSON.stringify([...quotes])).not.toContain('private-customer-auth');
        expect(JSON.stringify([...quotes])).not.toContain('source_channel_ids');
    });

    it('uses the model-specific rule over the group rule and reports the correct badge scope', async () => {
        const source = context();
        source.rules.push({
            id: 'model-rule',
            tier_key: 'sd',
            model_id: 'model-a',
            official_multiplier: 0.15,
            revision: 1,
        });
        source.tiers[0].models[0].current_ratio = 0.5;
        m.context.mockResolvedValue(source);
        const price = (await loadCustomerOfficialQuotes('customer-a')).get('model-a\u0000sd')!;
        expect(price.input_cny_per_1m).toBe(15);
        expect(price.customer_pricing).toMatchObject({ multiplier: 0.15, scope: 'model', official_multiplier: 0.15 });
    });

    it('shows official × multiplier exactly when the native ratio is a rounded repeating fraction', async () => {
        // Public price is official × 0.72; a 0.7 rule needs ratio 0.7 / 0.72 = 0.97222…, stored rounded up.
        const source = context();
        source.rules[0].official_multiplier = 0.7;
        source.options.ModelRatio = { 'model-a': 36 };
        const model = source.tiers[0].models[0];
        model.current_ratio = 0.972222222223;
        model.public_official_multiplier = 0.72;
        const sale = [72, 144, 7.2, 90, 144, 180];
        model.cells = model.cells.map((cell, index) => ({ ...cell, public_cny: sale[index], base_cny: sale[index] }));
        m.context.mockResolvedValue(source);
        const price = (await loadCustomerOfficialQuotes('customer-a')).get('model-a\u0000sd')!;
        expect(price.input_cny_per_1m).toBe(70);
        expect(price.output_cny_per_1m).toBe(140);
        expect(price.customer_pricing).toMatchObject({ official_multiplier: 0.7, public_official_multiplier: 0.72 });
    });

    it.each(['applying', 'failed', 'restoring', null])(
        'refuses to show a customer quote for binding status %s',
        async (status) => {
            const source = context();
            source.tiers[0].binding_status = status;
            m.context.mockResolvedValue(source);
            await expect(loadCustomerOfficialQuotes('customer-a')).rejects.toMatchObject({
                code: 'unverified_customer_price',
            });
        },
    );

    it('does not fall back to the public price when the live multiplier drifts or cannot be read', async () => {
        const source = context();
        source.tiers[0].models[0].current_ratio = 0.8;
        m.context.mockResolvedValue(source);
        await expect(loadCustomerOfficialQuotes('customer-a')).rejects.toMatchObject({ code: 'customer_price_drift' });
        m.context.mockRejectedValue(new Error('runtime unavailable'));
        await expect(loadCustomerOfficialQuotes('customer-a')).rejects.toThrow('runtime unavailable');
    });

    it('refuses a missing official reference or missing actual model price', async () => {
        const source = context();
        source.tiers[0].models[0].reference_available = false;
        m.context.mockResolvedValue(source);
        await expect(loadCustomerOfficialQuotes('customer-a')).rejects.toMatchObject({ code: 'missing_reference' });
        const unpriced = context();
        unpriced.options.ModelRatio = {};
        m.context.mockResolvedValue(unpriced);
        await expect(loadCustomerOfficialQuotes('customer-a')).rejects.toMatchObject({
            code: 'customer_price_missing',
        });
    });

    it('keeps ordinary users free of dedicated labels and unnecessary customer-price reads', async () => {
        m.count.mockResolvedValue(0);
        expect((await loadCustomerOfficialQuotes('ordinary-customer')).size).toBe(0);
        expect(m.context).not.toHaveBeenCalled();
    });
});

describe('API Key official-price summaries', () => {
    it('identifies the whole-group official multiplier and counts additional model rules separately', async () => {
        m.rules.mockResolvedValue([
            { tier_key: 'sd', model_key: '*', official_multiplier: 0.2 },
            { tier_key: 'sd', model_key: 'model-a', official_multiplier: 0.15 },
        ]);
        const source = context();
        source.rules.push({
            id: 'model-rule',
            tier_key: 'sd',
            model_id: 'model-a',
            official_multiplier: 0.15,
            revision: 1,
        });
        source.tiers[0].models[0].current_ratio = 0.5;
        m.context.mockResolvedValue(source);
        expect((await summarizeCustomerOfficialTiers('customer-a')).get('sd')).toEqual({
            multiplier: 0.2,
            model_overrides: 1,
        });
    });

    it('does not imply a group-wide discount when only one model has its own official multiplier', async () => {
        m.rules.mockResolvedValue([{ tier_key: 'sd', model_key: 'model-a', official_multiplier: 0.2 }]);
        const source = context();
        source.rules[0].model_id = 'model-a';
        m.context.mockResolvedValue(source);
        expect((await summarizeCustomerOfficialTiers('customer-a')).get('sd')).toEqual({
            multiplier: null,
            model_overrides: 1,
        });
    });

    it('does not render an official-price badge while the native binding is unverified', async () => {
        m.bindings.mockResolvedValue([{ tier_key: 'sd', status: 'applying' }]);
        const source = context();
        source.tiers[0].binding_status = 'applying';
        m.context.mockResolvedValue(source);
        await expect(summarizeCustomerOfficialTiers('customer-a')).rejects.toMatchObject({
            code: 'unverified_customer_price',
        });
    });

    it('checks native drift for the Key badge as well as the model quote, despite an active DB binding', async () => {
        const source = context();
        source.tiers[0].models[0].current_ratio = 0.8;
        m.context.mockResolvedValue(source);
        await expect(summarizeCustomerOfficialTiers('customer-a')).rejects.toMatchObject({
            code: 'customer_price_drift',
        });
    });

    it('returns no badge when no official rules exist', async () => {
        m.rules.mockResolvedValue([]);
        expect((await summarizeCustomerOfficialTiers('ordinary-customer')).size).toBe(0);
    });
});

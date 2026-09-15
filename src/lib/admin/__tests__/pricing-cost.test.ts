import { describe, expect, it } from 'vitest';
import {
    calculateCostPricing,
    calculateCostSample,
    pricingCostConfigSchema,
    PRICING_COST_MAX_RETAIL,
} from '../pricing-cost';
import type { PricingCostConfig } from '../pricing-cost-types';

function token(overrides: Partial<PricingCostConfig> = {}): PricingCostConfig {
    return {
        version: 1,
        basis: 'token',
        currency: 'credits',
        credits_per_cny: 10,
        upstream_multiplier: 0.2,
        markup_percent: 50,
        source_note: '¥1 buys 10 upstream credits; 0.2 upstream multiplier.',
        token_rates: { input: 10, output: 30, cache_read: 1, cache_write: 12.5 },
        variants: [],
        ...overrides,
    };
}
function media(basis: 'image' | 'video', overrides: Partial<PricingCostConfig> = {}): PricingCostConfig {
    return {
        version: 1,
        basis,
        currency: 'cny',
        credits_per_cny: 1,
        upstream_multiplier: 1,
        markup_percent: 50,
        source_note: '',
        token_rates: { input: null, output: null, cache_read: null, cache_write: null },
        variants: [
            {
                key: 'standard',
                label: basis === 'image' ? '2K' : '720p 无声',
                resolution: basis === 'image' ? '2K' : '720p',
                audio: 'any',
                reference_video: 'any',
                price: 0.2,
                minimum_units: 1,
                step_units: 1,
            },
        ],
        ...overrides,
    };
}

describe('cost-derived pricing calculations', () => {
    it('applies upstream credit conversion and markup once to all independent token prices', () => {
        const result = calculateCostPricing(token());
        expect(result.multiplier).toBe(1.5);
        expect(
            result.lines.map(({ key, cost, retail, profit, margin_percent, unit }) => ({
                key,
                cost,
                retail,
                profit,
                margin_percent,
                unit,
            })),
        ).toEqual([
            { key: 'input', cost: 0.2, retail: 0.3, profit: 0.1, margin_percent: 33.3333, unit: 'million_tokens' },
            { key: 'output', cost: 0.6, retail: 0.9, profit: 0.3, margin_percent: 33.3333, unit: 'million_tokens' },
            {
                key: 'cache_read',
                cost: 0.02,
                retail: 0.03,
                profit: 0.01,
                margin_percent: 33.3333,
                unit: 'million_tokens',
            },
            {
                key: 'cache_write',
                cost: 0.25,
                retail: 0.375,
                profit: 0.125,
                margin_percent: 33.3333,
                unit: 'million_tokens',
            },
        ]);
    });
    it('treats CNY as CNY and distinguishes markup from margin', () => {
        const result = calculateCostPricing(media('image'));
        expect(result.lines[0]).toMatchObject({ cost: 0.2, retail: 0.3, profit: 0.1, margin_percent: 33.3333 });
        expect(result.lines[0].margin_percent).not.toBe(50);
    });
    it('omits unknown cache prices and rejects trial use of an unknown cache rate', () => {
        const config = token({ token_rates: { input: 10, output: 30, cache_read: null, cache_write: null } });
        expect(calculateCostPricing(config).lines.map((line) => line.key)).toEqual(['input', 'output']);
        expect(() => calculateCostSample(config, 'cache_read', 100)).toThrow('明确价格');
    });
    it('retains deliberately quoted zero without interpreting missing values as zero', () => {
        const config = token({ token_rates: { input: 0, output: 30, cache_read: 0, cache_write: null } });
        expect(calculateCostPricing(config).lines[0]).toMatchObject({
            cost: 0,
            retail: 0,
            profit: 0,
            margin_percent: 0,
        });
        expect(calculateCostSample(config, 'input', 100)).toMatchObject({ cost: 0, retail: 0 });
        expect(
            pricingCostConfigSchema.safeParse(
                token({ token_rates: { input: null, output: 30, cache_read: null, cache_write: null } }),
            ).success,
        ).toBe(false);
    });
    it('rounds halfway decimal prices exactly instead of dropping them through binary float error', () => {
        const config = media('image', { markup_percent: 0 });
        config.variants[0].price = 1.23445;
        expect(calculateCostPricing(config).lines[0]).toMatchObject({ cost: 1.23445, retail: 1.2345 });
        config.variants[0].price = 0.00005;
        expect(calculateCostPricing(config).lines[0]).toMatchObject({ cost: 0.00005, retail: 0.0001 });
    });
    it('does not prematurely round purchasing cost before applying markup', () => {
        const config = media('image', { markup_percent: 100 });
        config.variants[0].price = 0.1234749;
        expect(calculateCostPricing(config).lines[0]).toMatchObject({ cost: 0.123475, retail: 0.2469 });
    });
    it('supports the inclusive maximum retail Decimal(12,4)', () => {
        const config = media('image', { markup_percent: 0 });
        config.variants[0].price = PRICING_COST_MAX_RETAIL;
        expect(calculateCostPricing(config).lines[0].retail).toBe(PRICING_COST_MAX_RETAIL);
        config.variants[0].price = PRICING_COST_MAX_RETAIL + 0.000001;
        expect(pricingCostConfigSchema.safeParse(config).success).toBe(false);
    });
    it('rejects a nonzero retail price that would be saved as free', () => {
        const config = media('image', { markup_percent: 0 });
        config.variants[0].price = 0.000049;
        expect(() => calculateCostPricing(config)).toThrow('不能保存成免费');
    });
    it('rejects a purchasing cost rounded to zero even if a very high markup makes retail representable', () => {
        const config = media('image', { markup_percent: 100_000 });
        config.variants[0].price = 0.00000049;
        expect(() => calculateCostPricing(config)).toThrow('实际成本小于');
    });
    it('rejects overflow after applying exchange, supplier multiplier, and markup', () => {
        const config = media('video', {
            currency: 'credits',
            credits_per_cny: 1e-200,
            upstream_multiplier: 1e15,
            markup_percent: 1e15,
        });
        expect(pricingCostConfigSchema.safeParse(config).success).toBe(false);
    });
    it('leaves the input draft unchanged', () => {
        const config = token();
        const before = structuredClone(config);
        calculateCostPricing(config);
        calculateCostSample(config, 'input', 1234);
        expect(config).toEqual(before);
    });
});

describe('unit-aware cost samples', () => {
    it('interprets token samples as actual counts and scales input/output/cache independently', () => {
        expect(calculateCostSample(token(), 'input', 1_000_000)).toMatchObject({
            billed_units: 1_000_000,
            cost: 0.2,
            retail: 0.3,
            profit: 0.1,
        });
        const output = calculateCostSample(token(), 'output', 500);
        expect(output.retail).toBeCloseTo(0.00045, 12);
        expect(output.cost).toBeCloseTo(0.0003, 12);
        expect(calculateCostSample(token(), 'cache_read', 1_000).retail).toBeCloseTo(0.00003, 12);
    });
    it('does not round small real token charges to zero in sample results', () => {
        const config = token({
            currency: 'cny',
            credits_per_cny: 1,
            upstream_multiplier: 1,
            markup_percent: 10_000,
            token_rates: { input: 0.000001, output: 1, cache_read: null, cache_write: null },
        });
        expect(calculateCostSample(config, 'input', 1).cost).toBeCloseTo(1e-12, 18);
        expect(calculateCostSample(config, 'input', 1).retail).toBeCloseTo(1e-10, 18);
        expect(calculateCostSample(config, 'input', 1).cost).toBeGreaterThan(0);
    });
    it('prices multiple images using the selected resolution only', () => {
        const config = media('image');
        config.variants.push({ ...config.variants[0], key: 'large', label: '4K', resolution: '4K', price: 0.8 });
        const sample = calculateCostSample(config, 'large', 3);
        expect(sample.billed_units).toBe(3);
        expect(sample.cost).toBeCloseTo(2.4, 12);
        expect(sample.retail).toBeCloseTo(3.6, 12);
        expect(sample.line.unit).toBe('image');
    });
    it('uses minimum duration plus incremental steps, not zero-based rounding', () => {
        const config = media('video');
        config.variants[0].minimum_units = 5;
        config.variants[0].step_units = 2;
        expect(calculateCostSample(config, 'standard', 1).billed_units).toBe(5);
        expect(calculateCostSample(config, 'standard', 5).billed_units).toBe(5);
        const sample = calculateCostSample(config, 'standard', 6);
        expect(sample.billed_units).toBe(7);
        expect(sample.cost).toBeCloseTo(1.4, 12);
        expect(sample.retail).toBeCloseTo(2.1, 12);
        expect(sample.line.unit).toBe('second');
    });
    it('does not overcharge exact fractional duration step boundaries through floating point', () => {
        const config = media('video');
        config.variants[0].minimum_units = 0.1;
        config.variants[0].step_units = 0.1;
        expect(calculateCostSample(config, 'standard', 0.3).billed_units).toBe(0.3);
        expect(calculateCostSample(config, 'standard', 0.31).billed_units).toBe(0.4);
    });
    it.each(['token', 'image', 'video'] as const)('charges no minimum for an empty %s sample', (basis) => {
        const config = basis === 'token' ? token() : media(basis);
        const key = basis === 'token' ? 'input' : 'standard';
        expect(calculateCostSample(config, key, 0)).toMatchObject({
            billed_units: 0,
            cost: 0,
            retail: 0,
            profit: 0,
            margin_percent: 0,
        });
    });
    it.each(['token', 'image'] as const)('rejects fractional %s counts', (basis) => {
        const config = basis === 'token' ? token() : media(basis);
        expect(() => calculateCostSample(config, basis === 'token' ? 'input' : 'standard', 1.5)).toThrow(
            '必须是非负整数',
        );
    });
    it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid sample units %s', (units) => {
        expect(() => calculateCostSample(token(), 'input', units)).toThrow();
    });
    it('rejects duration rounding that exceeds safe integer range', () => {
        const config = media('video');
        config.variants[0].minimum_units = Number.MAX_SAFE_INTEGER - 1;
        config.variants[0].step_units = 2;
        expect(() => calculateCostSample(config, 'standard', Number.MAX_SAFE_INTEGER)).toThrow('计费用量超出');
    });
    it('rejects a requested key from a different billing basis', () => {
        expect(() => calculateCostSample(media('image'), 'input', 1)).toThrow('未找到');
    });
});

describe('strict purchasing term validation', () => {
    it.each(['credits_per_cny', 'upstream_multiplier'] as const)(
        'rejects invalid positive field %s without arithmetic exceptions',
        (key) => {
            for (const value of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
                expect(pricingCostConfigSchema.safeParse(token({ [key]: value })).success).toBe(false);
            }
        },
    );
    it.each([-1, NaN, Infinity])('rejects invalid markup %s', (value) => {
        expect(pricingCostConfigSchema.safeParse(token({ markup_percent: value })).success).toBe(false);
    });
    it('rejects an ambiguous currency exchange and legacy group ratio', () => {
        expect(pricingCostConfigSchema.safeParse(token({ currency: 'cny' })).success).toBe(false);
        expect(pricingCostConfigSchema.safeParse({ ...token(), group_ratio: 2 }).success).toBe(false);
    });
    it('does not coerce empty or numeric strings, missing quotes, or unknown versions', () => {
        expect(pricingCostConfigSchema.safeParse({ ...token(), upstream_multiplier: '' }).success).toBe(false);
        expect(pricingCostConfigSchema.safeParse({ ...token(), upstream_multiplier: '1' }).success).toBe(false);
        expect(pricingCostConfigSchema.safeParse({ ...token(), token_rates: { input: 1 } }).success).toBe(false);
        expect(pricingCostConfigSchema.safeParse({ ...token(), version: 2 }).success).toBe(false);
    });
    it('rejects mixing token and media quote units even when the irrelevant rate is zero', () => {
        expect(pricingCostConfigSchema.safeParse(token({ variants: media('image').variants })).success).toBe(false);
        const config = media('image');
        config.token_rates.input = 0;
        expect(pricingCostConfigSchema.safeParse(config).success).toBe(false);
        expect(pricingCostConfigSchema.safeParse(media('video', { variants: [] })).success).toBe(false);
    });
    it('rejects duplicate keys and duplicate billing specifications', () => {
        const config = media('image');
        config.variants.push({ ...config.variants[0], resolution: '4K' });
        expect(pricingCostConfigSchema.safeParse(config).success).toBe(false);
        config.variants[1].key = 'other';
        config.variants[1].resolution = '2k';
        expect(pricingCostConfigSchema.safeParse(config).success).toBe(false);
    });
    it('allows independent audio and reference-video variants at one resolution', () => {
        const config = media('video');
        config.variants[0].audio = 'silent';
        config.variants.push({ ...config.variants[0], key: 'audio', audio: 'audio', price: 0.5 });
        config.variants.push({ ...config.variants[0], key: 'reference', reference_video: 'with', price: 0.6 });
        expect(calculateCostPricing(config).lines).toHaveLength(3);
    });
    it('rejects fractional image batches, invalid increments, and video-only conditions on images', () => {
        for (const patch of [
            { minimum_units: 0.5 },
            { step_units: 0.5 },
            { step_units: 0 },
            { minimum_units: -1 },
            { audio: 'audio' as const },
            { reference_video: 'with' as const },
        ]) {
            const config = media('image');
            Object.assign(config.variants[0], patch);
            expect(pricingCostConfigSchema.safeParse(config).success).toBe(false);
        }
    });
    it('limits notes and rejects blank/unsafe identifiers and unknown fields in nested objects', () => {
        expect(pricingCostConfigSchema.safeParse(token({ source_note: 'x'.repeat(501) })).success).toBe(false);
        for (const patch of [{ key: '../bad' }, { label: ' ' }, { resolution: '' }, { cost: 1 }]) {
            const config = media('image');
            Object.assign(config.variants[0], patch);
            expect(pricingCostConfigSchema.safeParse(config).success).toBe(false);
        }
    });
});

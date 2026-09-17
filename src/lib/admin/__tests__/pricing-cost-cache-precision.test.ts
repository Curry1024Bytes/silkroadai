import { describe, expect, it } from 'vitest';
import { calculateCostPricing, calculateCostSample, pricingCostConfigSchema } from '../pricing-cost';
import type { PricingCostConfig } from '../pricing-cost-types';

function fixture(cacheRead: number | null = 0.5): PricingCostConfig {
    return {
        version: 1,
        basis: 'token',
        currency: 'credits',
        credits_per_cny: 10,
        upstream_multiplier: 1.3,
        retail_multiplier: 1.625,
        markup_percent: 0,
        source_note: 'Synthetic 1:10 credit quote',
        token_rates: { input: 5, output: 30, cache_read: cacheRead, cache_write: null },
        variants: [],
    };
}

describe('cached-token quote precision', () => {
    it('retains 0.08125 from a 1.625 sale multiplier without altering legacy input/output precision', () => {
        const lines = calculateCostPricing(fixture()).lines;
        expect(lines.map(({ key, cost, retail }) => ({ key, cost, retail }))).toEqual([
            { key: 'input', cost: 0.65, retail: 0.8125 },
            { key: 'output', cost: 3.9, retail: 4.875 },
            { key: 'cache_read', cost: 0.065, retail: 0.08125 },
        ]);
        expect(calculateCostSample(fixture(), 'cache_read', 1_000_000).retail).toBe(0.08125);
    });

    it('does not turn a nonzero cache price into a free quote at four decimals', () => {
        expect(pricingCostConfigSchema.safeParse(fixture(0.00001)).success).toBe(true);
        expect(calculateCostPricing(fixture(0.00001)).lines.at(-1)).toMatchObject({
            key: 'cache_read',
            cost: 0.000001,
            retail: 0.000001625,
        });
    });

    it('retains an explicit zero cache price while missing cache prices remain absent', () => {
        expect(calculateCostPricing(fixture(0)).lines.at(-1)).toMatchObject({
            key: 'cache_read',
            cost: 0,
            retail: 0,
        });
        expect(calculateCostPricing(fixture(null)).lines.map((line) => line.key)).toEqual(['input', 'output']);
        expect(() => calculateCostSample(fixture(null), 'cache_read', 1)).toThrow('明确价格');
    });

    it('keeps the six-decimal purchasing-cost floor even with more precise cached-token retail', () => {
        const parsed = pricingCostConfigSchema.safeParse(fixture(0.000001));
        expect(parsed.success).toBe(false);
        if (!parsed.success)
            expect(parsed.error.issues).toContainEqual(
                expect.objectContaining({
                    path: ['token_rates', 'cache_read'],
                    message: expect.stringContaining('6 位小数'),
                }),
            );
    });

    it('retains four-decimal input/output prices and twelve-decimal supported cache-write quotes', () => {
        const config = fixture(0.5);
        config.token_rates = { input: 5.123456, output: 30.123456, cache_read: 0.5, cache_write: 0.5123456 };
        expect(calculateCostPricing(config).lines.map(({ key, retail }) => ({ key, retail }))).toEqual([
            { key: 'input', retail: 0.8326 },
            { key: 'output', retail: 4.8951 },
            { key: 'cache_read', retail: 0.08125 },
            { key: 'cache_write', retail: 0.08325616 },
        ]);
    });

    it('does not grant token precision to an image variant named cache_read', () => {
        const config = fixture();
        config.basis = 'image';
        config.token_rates = { input: null, output: null, cache_read: null, cache_write: null };
        config.variants = [
            {
                key: 'cache_read',
                label: 'Synthetic image',
                resolution: 'standard',
                audio: 'any',
                reference_video: 'any',
                price: 0.5,
                minimum_units: 1,
                step_units: 1,
            },
        ];
        expect(calculateCostPricing(config).lines[0].retail).toBe(0.0813);
    });
});

describe('cache-write quote schema and legacy compatibility', () => {
    it('never injects the new 1h key into old stored JSON or its confirmation fingerprint', () => {
        const legacy = fixture();
        expect(JSON.stringify(pricingCostConfigSchema.parse(legacy))).toBe(JSON.stringify(legacy));
        expect(Object.hasOwn(pricingCostConfigSchema.parse(legacy).token_rates, 'cache_write_1h')).toBe(false);
    });
    it.each([null, undefined])('does not turn missing 1h rate %s into free cache creation', (price) => {
        const config = fixture();
        if (price === null) config.token_rates.cache_write_1h = null;
        expect(calculateCostPricing(config).lines.some((line) => line.key === 'cache_write_1h')).toBe(false);
        expect(() => calculateCostSample(config, 'cache_write_1h', 100)).toThrow('明确价格');
    });
    it('keeps ordinary cache creation and 1h prices independent, including explicit zero', () => {
        const config = fixture();
        config.retail_multiplier = 1.6;
        config.token_rates.cache_write = 6.25;
        config.token_rates.cache_write_1h = 10;
        expect(calculateCostPricing(config).lines.slice(-2)).toMatchObject([
            { key: 'cache_write', cost: 0.8125, retail: 1 },
            { key: 'cache_write_1h', cost: 1.3, retail: 1.6 },
        ]);
        config.token_rates.cache_write_1h = 0;
        expect(calculateCostSample(config, 'cache_write_1h', 1000000)).toMatchObject({ cost: 0, retail: 0 });
    });
    it('preserves nonzero cached-token precision and rejects invalid optional 1h rates', () => {
        const config = fixture();
        config.token_rates.cache_write_1h = 0.00001;
        expect(calculateCostPricing(config).lines.at(-1)).toMatchObject({ retail: 0.000001625 });
        for (const value of [-1, NaN, Infinity]) {
            config.token_rates.cache_write_1h = value;
            expect(pricingCostConfigSchema.safeParse(config).success).toBe(false);
        }
    });
});

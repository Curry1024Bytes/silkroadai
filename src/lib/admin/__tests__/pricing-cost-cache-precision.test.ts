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

    it('retains four-decimal prices for input, output, and unsupported cache-write quotes', () => {
        const config = fixture(0.5);
        config.token_rates = { input: 5.123456, output: 30.123456, cache_read: 0.5, cache_write: 0.5123456 };
        expect(calculateCostPricing(config).lines.map(({ key, retail }) => ({ key, retail }))).toEqual([
            { key: 'input', retail: 0.8326 },
            { key: 'output', retail: 4.8951 },
            { key: 'cache_read', retail: 0.08125 },
            { key: 'cache_write', retail: 0.0833 },
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

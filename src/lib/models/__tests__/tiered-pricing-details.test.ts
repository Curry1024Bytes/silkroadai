import { describe, expect, it } from 'vitest';
import {
    formatTieredPrice,
    parseTieredPricingDetails,
    scalePricingAmount,
    scaleTieredPricingDetails,
    tieredPricingConditionLabel,
} from '../tiered-pricing-details';
import type { TieredPricingDetails } from '@/lib/admin/pricing-publish-types';

const fixture = (): TieredPricingDetails => ({
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
            rates: { input: 0.8, output: 4.8, cache_read: 0.08, cache_write: null, cache_write_1h: null },
        },
        {
            name: 'tier_2',
            min_input_tokens: 272000,
            max_input_tokens: null,
            min_inclusive: true,
            max_inclusive: false,
            rates: { input: 1.6, output: 7.2, cache_read: 0.16, cache_write: null, cache_write_1h: null },
        },
    ],
});

describe('customer tiered pricing details', () => {
    it('distinguishes legacy absence from corrupt published metadata', () => {
        expect(parseTieredPricingDetails(null)).toBeNull();
        expect(parseTieredPricingDetails(undefined)).toBeNull();
        expect(parseTieredPricingDetails(fixture())).toEqual(fixture());
        expect(() => parseTieredPricingDetails({})).toThrow('Invalid tiered');
    });
    it('preserves exact cache amounts, thresholds and whole-request semantics under dedicated replacements', () => {
        const original = fixture();
        const result = scaleTieredPricingDetails(original, 0.18 / 0.16);
        expect(result.tiers.map((tier) => tier.rates)).toEqual([
            { input: 0.9, output: 5.4, cache_read: 0.09, cache_write: null, cache_write_1h: null },
            { input: 1.8, output: 8.1, cache_read: 0.18, cache_write: null, cache_write_1h: null },
        ]);
        expect(result.semantics).toBe('whole_request');
        expect(result.tiers[0].max_input_tokens).toBe(272000);
        expect(result.tiers[1].min_inclusive).toBe(true);
        expect(original).toEqual(fixture());
        expect(formatTieredPrice(0.08125)).toBe('0.08125');
        expect(formatTieredPrice(0)).toBe('0');
        expect(formatTieredPrice(1.000000000001)).toBe('1.000000000001');
    });
    it.each(['gap', 'overlap', 'open-end', 'different-cache', 'duplicate', 'negative', 'unknown'] as const)(
        'rejects malformed %s metadata instead of showing a flat price',
        (kind) => {
            const value = fixture();
            if (kind === 'gap') value.tiers[1].min_input_tokens = 272001;
            if (kind === 'overlap') value.tiers[1].min_inclusive = false;
            if (kind === 'open-end') value.tiers[1].max_input_tokens = 999999;
            if (kind === 'different-cache') value.tiers[1].rates.cache_read = null;
            if (kind === 'duplicate') value.tiers[1].name = 'base';
            if (kind === 'negative') value.tiers[0].rates.input = -1;
            if (kind === 'unknown') Object.assign(value, { unexpected: true });
            expect(() => parseTieredPricingDetails(value)).toThrow('Invalid tiered');
        },
    );
    it('labels the exact 272000 boundary rather than rounding it to 272K', () => {
        const [base, long] = fixture().tiers;
        expect(tieredPricingConditionLabel(base)).toBe('完整输入 token < 272,000');
        expect(tieredPricingConditionLabel(long)).toBe('完整输入 token ≥ 272,000');
        expect(tieredPricingConditionLabel(long, true)).toBe('Full input tokens ≥ 272,000');
    });
    it('allows zero effective price but rejects invalid or vanishing quotes', () => {
        expect(scalePricingAmount(0.8, 0)).toBe(0);
        for (const factor of [-1, NaN, Infinity]) expect(() => scalePricingAmount(0.8, factor)).toThrow();
        expect(() => scalePricingAmount(0.000000000001, 0.00001)).toThrow();
        expect(() => scalePricingAmount(Number.MAX_SAFE_INTEGER, 2)).toThrow();
    });
});

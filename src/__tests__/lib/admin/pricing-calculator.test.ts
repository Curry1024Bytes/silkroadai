import { describe, expect, it } from 'vitest';
import { calculatePricing } from '@/lib/admin/pricing-calculator';

describe('pricing calculator', () => {
    it('reproduces the verified Claude Fable economics', () => {
        const result = calculatePricing({
            upstreamCreditsPerCny: 10,
            upstreamChannelRatio: 10,
            official: { inputUsdPer1m: 10, outputUsdPer1m: 50, cacheReadUsdPer1m: 1, cacheWriteUsdPer1m: 12.5 },
            markupRate: 0.2,
            groupRatio: 1.2,
            portalChatFxCnyPer1mQuota: 14.4,
            quotaPerUsd: 500_000,
            sample: { input: 2, output: 2642, cacheRead: 37988, cacheWrite: 7867 },
        });

        expect(result.upstreamCostCnyPer1m).toEqual({
            input: 10,
            output: 50,
            cacheRead: 1,
            cacheWrite: 12.5,
            total: 73.5,
        });
        expect(result.retailCnyPer1m).toEqual({ input: 12, output: 60, cacheRead: 1.2, cacheWrite: 15, total: 88.2 });
        expect(result.ratios).toEqual({
            modelRatio: 0.694444,
            completionRatio: 5,
            cacheRatio: 0.1,
            createCacheRatio: 1.25,
        });
        expect(result.sample?.retailCny).toBeCloseTo(0.322135, 6);
        expect(result.sample?.upstreamCostCny).toBeCloseTo(0.2684455, 7);
        expect(result.sample?.quota).toBe(11185);
    });

    it('keeps the recharge ratio explicit and rejects ambiguous invalid input', () => {
        expect(() =>
            calculatePricing({
                upstreamCreditsPerCny: 0,
                upstreamChannelRatio: 10,
                official: { inputUsdPer1m: 1, outputUsdPer1m: 1, cacheReadUsdPer1m: 0, cacheWriteUsdPer1m: 0 },
                markupRate: 0.2,
                groupRatio: 1,
                portalChatFxCnyPer1mQuota: 14.4,
                quotaPerUsd: 500_000,
            }),
        ).toThrow('upstreamCreditsPerCny');
    });
});

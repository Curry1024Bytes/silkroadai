import { describe, expect, it } from 'vitest';

import {
    cnyMatches,
    estimateBill,
    margin,
    parseLoggedBill,
    pickTier,
    purchaseRateFromQuote,
    quotaMatches,
    type BillUsage,
} from '@/lib/admin/pricing-bill-check';
import type { TieredPricingBuildTier } from '@/lib/admin/pricing-tiered-expression';

const units = { base_fx: 1, quota_per_usd: 500_000 };
const usage = (patch: Partial<BillUsage>): BillUsage => ({
    prompt: 0,
    completion: 0,
    cache_read: 0,
    cache_write: 0,
    cache_write_1h: 0,
    anthropic: false,
    ...patch,
});
const token = { mode: 'token' as const, input: 5, output: 40, cache_read: 0.5, cache_write: 6.25 };

describe('estimateBill — token mode', () => {
    it('subtracts cache from an OpenAI-style prompt', () => {
        const bill = estimateBill(
            token,
            usage({ prompt: 1_000_000, completion: 100_000, cache_read: 400_000, cache_write: 100_000 }),
            1.2,
            0.3,
            units,
        );
        expect(bill.lines.map((row) => [row.key, row.tokens])).toEqual([
            ['input', 500_000],
            ['output', 100_000],
            ['cache_read', 400_000],
            ['cache_write', 100_000],
        ]);
        // 2.5 + 4 + 0.2 + 0.625 = 7.325 official $
        expect(bill.official_usd).toBeCloseTo(7.325, 9);
        expect(bill.quota).toBe(Math.round(7.325 * 500_000 * 1.2));
        expect(bill.customer_cny).toBeCloseTo(8.79, 9);
        expect(bill.upstream_cny).toBeCloseTo(2.1975, 9);
    });

    it('keeps an Anthropic prompt as-is and prices 1h writes at 1.6×', () => {
        const bill = estimateBill(
            token,
            usage({ prompt: 1000, cache_read: 5000, cache_write: 2000, cache_write_1h: 1000, anthropic: true }),
            1,
            null,
            units,
        );
        expect(bill.lines.map((row) => [row.key, row.tokens, row.price])).toEqual([
            ['input', 1000, 5],
            ['cache_read', 5000, 0.5],
            ['cache_write', 2000, 6.25],
            ['cache_write_1h', 1000, 10],
        ]);
        expect(bill.upstream_cny).toBeNull();
    });

    it('merges 1h writes into the write bucket for OpenAI usage and clamps the input', () => {
        const bill = estimateBill(token, usage({ prompt: 100, cache_read: 80, cache_write_1h: 50 }), 1, null, units);
        expect(bill.lines.map((row) => [row.key, row.tokens])).toEqual([
            ['cache_read', 80],
            ['cache_write', 50],
        ]);
    });

    it('falls back to new-api default cache ratios', () => {
        const bill = estimateBill(
            { ...token, cache_read: null, cache_write: null },
            usage({ prompt: 3000, cache_read: 1000, cache_write: 1000, anthropic: true }),
            1,
            null,
            units,
        );
        expect(bill.lines.find((row) => row.key === 'cache_read')?.price).toBe(5);
        expect(bill.lines.find((row) => row.key === 'cache_write')?.price).toBe(6.25);
    });

    it('charges at least 1 quota for a non-zero bill and 0 for an empty one', () => {
        expect(estimateBill(token, usage({ prompt: 1 }), 0.01, null, units).quota).toBe(1);
        expect(estimateBill(token, usage({}), 1, null, units).quota).toBe(0);
    });
});

describe('estimateBill — per call and tiered', () => {
    it('prices a per-call model once', () => {
        const bill = estimateBill({ mode: 'per_call', price: 0.04 }, usage({ prompt: 999 }), 1.2, 0.5, units);
        expect(bill.lines).toEqual([{ key: 'per_call', tokens: 1, price: 0.04, usd: 0.04 }]);
        expect(bill.quota).toBe(24_000);
        expect(bill.upstream_cny).toBeCloseTo(0.02, 9);
    });

    const tiers: TieredPricingBuildTier[] = [
        {
            max_input_tokens: 200_000,
            max_inclusive: true,
            rates: { input: 3, output: 15, cache_read: 0.3, cache_write: null, cache_write_1h: null },
        },
        {
            max_input_tokens: null,
            max_inclusive: false,
            rates: { input: 6, output: 22.5, cache_read: 0.6, cache_write: null, cache_write_1h: null },
        },
    ];

    it('picks the tier by full input length', () => {
        expect(pickTier(tiers, 200_000)).toBe(0);
        expect(pickTier(tiers, 200_001)).toBe(1);
        expect(pickTier([{ ...tiers[0], max_inclusive: false }, tiers[1]], 200_000)).toBe(1);
    });

    it('subtracts only priced cache variables from an OpenAI prompt', () => {
        const bill = estimateBill(
            { mode: 'tiered', tiers },
            usage({ prompt: 150_000, completion: 1000, cache_read: 50_000, cache_write: 10_000 }),
            1,
            null,
            units,
        );
        expect(bill.tier).toBe(0);
        // cache_write is not in the expression: it stays inside the input.
        expect(bill.lines.map((row) => [row.key, row.tokens])).toEqual([
            ['input', 100_000],
            ['output', 1000],
            ['cache_read', 50_000],
        ]);
    });

    it('does not adjust an Anthropic prompt but counts cache toward the tier length', () => {
        const noCacheRate = tiers.map((tier) => ({ ...tier, rates: { ...tier.rates, cache_read: null } }));
        const bill = estimateBill(
            { mode: 'tiered', tiers: noCacheRate },
            usage({ prompt: 1000, completion: 10, cache_read: 250_000, anthropic: true }),
            1,
            null,
            units,
        );
        expect(bill.tier).toBe(1);
        expect(bill.lines.map((row) => [row.key, row.tokens])).toEqual([
            ['input', 1000],
            ['output', 10],
        ]);
    });
});

describe('matchers and rates', () => {
    it('matches quota within rounding', () => {
        expect(quotaMatches(1000, 1001)).toBe(true);
        expect(quotaMatches(1_000_000, 1_000_900)).toBe(true);
        expect(quotaMatches(1000, 1003)).toBe(false);
    });

    it('matches ¥ within the tolerance', () => {
        expect(cnyMatches(1.01, 1)).toBe(true);
        expect(cnyMatches(1.03, 1)).toBe(false);
        expect(cnyMatches(1.004, 1, 0.005)).toBe(true);
    });

    it('computes the profit multiple and gross margin', () => {
        expect(margin(0.3, 1.2)).toEqual({ multiple: 4, gross: 0.75 });
        expect(margin(null, 1.2)).toBeNull();
        expect(margin(0.3, 0)).toBeNull();
    });

    it('derives a purchase rate from an upstream quote', () => {
        expect(purchaseRateFromQuote(10, 3)).toBeCloseTo(0.3, 12);
        expect(purchaseRateFromQuote(0, 3)).toBeNull();
        expect(purchaseRateFromQuote(10, Number.NaN)).toBeNull();
    });
});

describe('parseLoggedBill', () => {
    const log = {
        request_id: 'r1',
        created_at: 1_760_000_000,
        model_name: 'claude-sonnet-4-6',
        group: 'default',
        channel: 7,
        quota: 1234,
        prompt_tokens: 10,
        completion_tokens: 20,
    };

    it('reads Anthropic cache splits and recorded ratios', () => {
        const parsed = parseLoggedBill({
            ...log,
            other: JSON.stringify({
                usage_semantic: 'anthropic',
                cache_tokens: 300,
                cache_creation_tokens: 700,
                cache_creation_tokens_5m: 400,
                cache_creation_tokens_1h: 200,
                model_ratio: 1.5,
                completion_ratio: 5,
                group_ratio: 1.2,
                user_group_ratio: -1,
                model_price: -1,
                billing_mode: 'tiered_expr',
            }),
        });
        expect(parsed.usage).toEqual({
            prompt: 10,
            completion: 20,
            cache_read: 300,
            cache_write: 500,
            cache_write_1h: 200,
            anthropic: true,
        });
        expect(parsed.recorded).toMatchObject({
            model_ratio: 1.5,
            group_ratio: 1.2,
            user_group_ratio: null,
            model_price: null,
            tiered: true,
        });
    });

    it('tolerates a missing or broken other field', () => {
        const parsed = parseLoggedBill({ ...log, other: 'not json' });
        expect(parsed.usage).toMatchObject({ cache_read: 0, cache_write: 0, anthropic: false });
        expect(parsed.recorded).toMatchObject({ model_ratio: null, tiered: false, user_group_ratio: null });
        expect(
            parseLoggedBill({ ...log, other: JSON.stringify({ user_group_ratio: 0.9 }) }).recorded.user_group_ratio,
        ).toBe(0.9);
    });
});

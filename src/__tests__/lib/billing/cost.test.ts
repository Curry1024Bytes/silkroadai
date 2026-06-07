import { describe, expect, it } from 'vitest';
import { computeUsageCost, pickEffectivePrice, toNum } from '@/lib/billing/cost';

describe('computeUsageCost', () => {
    const gpt = { input_cny_per_1m: 2.5, output_cny_per_1m: 10 };

    it('gpt-5.4 ¥2.5/¥10: 1M in + 1M out → ¥12.5 (matched)', () => {
        expect(computeUsageCost(gpt, 1_000_000, 1_000_000)).toEqual({ costCny: 12.5, matched: true });
    });

    it('partial tokens: 500k in + 250k out → ¥3.75', () => {
        expect(computeUsageCost(gpt, 500_000, 250_000)).toEqual({ costCny: 3.75, matched: true });
    });

    it('accepts Decimal-as-string prices (Prisma JSON shape)', () => {
        const r = computeUsageCost({ input_cny_per_1m: '2.5', output_cny_per_1m: '10' }, 1_000_000, 0);
        expect(r).toEqual({ costCny: 2.5, matched: true });
    });

    it('no price → matched=false, cost 0', () => {
        expect(computeUsageCost(null, 1_000_000, 1_000_000)).toEqual({ costCny: 0, matched: false });
    });

    it('image-only / incomplete price (missing in or out) → matched=false, cost 0 (no guessing)', () => {
        expect(computeUsageCost({ input_cny_per_1m: null, output_cny_per_1m: null }, 5, 5)).toEqual({
            costCny: 0,
            matched: false,
        });
        expect(computeUsageCost({ input_cny_per_1m: 2.5, output_cny_per_1m: null }, 1_000_000, 1_000_000)).toEqual({
            costCny: 0,
            matched: false,
        });
    });

    it('rounds to 8 decimals (no float long-tail)', () => {
        // 333 in × ¥3/1M = 0.000999; keep it clean to 8 dp
        const r = computeUsageCost({ input_cny_per_1m: 3, output_cny_per_1m: 3 }, 333, 0);
        expect(r.matched).toBe(true);
        expect(r.costCny).toBe(0.000999);
    });
});

describe('toNum', () => {
    it('coerces string/number, guards null/empty/NaN', () => {
        expect(toNum('2.5')).toBe(2.5);
        expect(toNum(3)).toBe(3);
        expect(toNum(null)).toBeNull();
        expect(toNum('')).toBeNull();
        expect(toNum('abc')).toBeNull();
    });
});

describe('pickEffectivePrice (versioned: latest effective_from <= log time, per tier)', () => {
    const prices = [
        { id: 'p1', tier: 'pool', effective_from: '2026-06-01T00:00:00Z' },
        { id: 'p2', tier: 'pool', effective_from: '2026-06-05T00:00:00Z' },
        { id: 'p3', tier: 'official', effective_from: '2026-06-03T00:00:00Z' },
    ];

    it('picks the latest pool price effective at the log time', () => {
        expect(pickEffectivePrice(prices, 'pool', new Date('2026-06-04T12:00:00Z'))?.id).toBe('p1');
        expect(pickEffectivePrice(prices, 'pool', new Date('2026-06-06T00:00:00Z'))?.id).toBe('p2');
    });

    it('returns null when all versions are in the future', () => {
        expect(pickEffectivePrice(prices, 'pool', new Date('2026-05-01T00:00:00Z'))).toBeNull();
    });

    it('filters by tier', () => {
        expect(pickEffectivePrice(prices, 'official', new Date('2026-06-06T00:00:00Z'))?.id).toBe('p3');
        expect(pickEffectivePrice(prices, 'nonexistent', new Date('2026-06-06T00:00:00Z'))).toBeNull();
    });

    it('order-independent (does not assume input sorted)', () => {
        const shuffled = [prices[1], prices[2], prices[0]];
        expect(pickEffectivePrice(shuffled, 'pool', new Date('2026-06-06T00:00:00Z'))?.id).toBe('p2');
    });
});

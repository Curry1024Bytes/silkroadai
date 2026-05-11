/**
 * PR-U1 — tier rules unit tests.
 *
 * Thresholds (operator-decided):
 *   bronze < 10,000 → 10%
 *   silver 10k-100k → 15%
 *   gold ≥ 100,000  → 20%
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { TIER_RULES, tierForGmv, rateForTier, tierProgress, isTierUpgrade } from '@/lib/reseller/tier';

describe('TIER_RULES', () => {
    it('is sorted ascending by minGmvCny', () => {
        for (let i = 1; i < TIER_RULES.length; i++) {
            expect(TIER_RULES[i].minGmvCny).toBeGreaterThan(TIER_RULES[i - 1].minGmvCny);
        }
    });
});

describe('tierForGmv', () => {
    it.each([
        [0, 'bronze', 0.1],
        [1, 'bronze', 0.1],
        [9_999.99, 'bronze', 0.1],
        [10_000, 'silver', 0.15],
        [50_000, 'silver', 0.15],
        [99_999.99, 'silver', 0.15],
        [100_000, 'gold', 0.2],
        [1_000_000, 'gold', 0.2],
    ])('gmv=%s → tier=%s rate=%s', (gmv, tier, rate) => {
        const r = tierForGmv(gmv);
        expect(r.tier).toBe(tier);
        expect(r.rate).toBe(rate);
    });

    it('treats negative / NaN gmv as bronze', () => {
        expect(tierForGmv(-100).tier).toBe('bronze');
        expect(tierForGmv(NaN).tier).toBe('bronze');
    });

    it('accepts a Prisma.Decimal', () => {
        expect(tierForGmv(new Prisma.Decimal('25000')).tier).toBe('silver');
        expect(tierForGmv(new Prisma.Decimal('150000')).tier).toBe('gold');
    });
});

describe('rateForTier', () => {
    it.each([
        ['bronze', 0.1],
        ['silver', 0.15],
        ['gold', 0.2],
    ] as const)('%s → %s', (tier, rate) => {
        expect(rateForTier(tier)).toBe(rate);
    });
});

describe('tierProgress', () => {
    it('bronze user → next=silver + 10k gap', () => {
        const p = tierProgress(0);
        expect(p).not.toBeNull();
        expect(p!.next.tier).toBe('silver');
        expect(p!.gmvNeededToNextCny).toBe(10_000);
    });

    it('silver user near top → next=gold + small gap', () => {
        const p = tierProgress(99_000);
        expect(p).not.toBeNull();
        expect(p!.next.tier).toBe('gold');
        expect(p!.gmvNeededToNextCny).toBe(1_000);
    });

    it('gold user → null (top tier)', () => {
        expect(tierProgress(500_000)).toBeNull();
    });

    it('exactly-at-threshold user is in that tier already', () => {
        const p = tierProgress(10_000);
        expect(p!.next.tier).toBe('gold');
        expect(p!.gmvNeededToNextCny).toBe(90_000);
    });
});

describe('isTierUpgrade', () => {
    it('returns upgraded=false when same tier', () => {
        expect(isTierUpgrade(100, 5_000).upgraded).toBe(false);
        expect(isTierUpgrade(50_000, 75_000).upgraded).toBe(false);
    });

    it('returns upgraded=true with from/to when crossing bronze→silver', () => {
        const r = isTierUpgrade(9_999, 10_500);
        expect(r.upgraded).toBe(true);
        if (r.upgraded) {
            expect(r.from).toBe('bronze');
            expect(r.to).toBe('silver');
        }
    });

    it('skips tier on huge jump (bronze→gold)', () => {
        const r = isTierUpgrade(0, 500_000);
        expect(r.upgraded).toBe(true);
        if (r.upgraded) {
            expect(r.from).toBe('bronze');
            expect(r.to).toBe('gold');
        }
    });

    it('exact threshold boundary triggers upgrade', () => {
        const r = isTierUpgrade(9_999.99, 10_000);
        expect(r.upgraded).toBe(true);
    });
});

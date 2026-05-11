/**
 * Reseller tier rules (PR-U1).
 *
 * Tier is a function of `cumulative_gmv` (CNY total of all attributed
 * recharges so far). Rate is applied at commission INSERT time and
 * snapshotted on the row — already-confirmed commissions are NOT
 * back-paid when a reseller crosses into a higher tier.
 *
 * Thresholds (operator-decided):
 *   bronze: 0       ≤ gmv < 10,000      → 10% commission
 *   silver: 10,000  ≤ gmv < 100,000     → 15%
 *   gold:   100,000 ≤ gmv               → 20%
 *
 * The thresholds live here (a single source of truth) so the cron,
 * the dashboard, and the commission hook all agree. Changing tier
 * rules in the future = edit this file + ship a migration if you also
 * want to recompute historical rows (not done at launch).
 */
import { Prisma } from '@prisma/client';

export type ResellerTierKey = 'bronze' | 'silver' | 'gold';

export interface TierRule {
    tier: ResellerTierKey;
    /** Lower bound (inclusive), in CNY. */
    minGmvCny: number;
    /** Commission rate as a fraction (0.10 = 10%). */
    rate: number;
}

/**
 * Tier table, sorted by `minGmvCny` ascending. The lookup helpers below
 * scan top-down and pick the lowest matching tier, so order matters.
 * If you ever insert a new tier, keep this sorted.
 */
export const TIER_RULES: readonly TierRule[] = [
    { tier: 'bronze', minGmvCny: 0, rate: 0.1 },
    { tier: 'silver', minGmvCny: 10_000, rate: 0.15 },
    { tier: 'gold', minGmvCny: 100_000, rate: 0.2 },
] as const;

/**
 * Return the tier a reseller is in given their cumulative GMV.
 *
 * Negative GMV (shouldn't happen — refund flow doesn't subtract from
 * cumulative_gmv today) is treated as 0 / bronze.
 */
export function tierForGmv(cumulativeGmvCny: Prisma.Decimal | number): TierRule {
    const gmv = typeof cumulativeGmvCny === 'number' ? cumulativeGmvCny : Number(cumulativeGmvCny);
    if (!Number.isFinite(gmv) || gmv < 0) return TIER_RULES[0];

    // Scan from highest tier down — first match wins.
    for (let i = TIER_RULES.length - 1; i >= 0; i--) {
        if (gmv >= TIER_RULES[i].minGmvCny) return TIER_RULES[i];
    }
    return TIER_RULES[0];
}

/**
 * Return the rate for a given tier (used when caller already knows the
 * tier and just wants to apply the rate, e.g. mocking a future commission).
 */
export function rateForTier(tier: ResellerTierKey): number {
    const rule = TIER_RULES.find((r) => r.tier === tier);
    return rule ? rule.rate : TIER_RULES[0].rate;
}

/**
 * Return "next tier + gmv needed to reach it" for UI progress bars on
 * the dashboard. Returns null when already at the top tier.
 */
export function tierProgress(cumulativeGmvCny: Prisma.Decimal | number): {
    next: TierRule;
    gmvNeededToNextCny: number;
} | null {
    const gmv = typeof cumulativeGmvCny === 'number' ? cumulativeGmvCny : Number(cumulativeGmvCny);
    const current = tierForGmv(gmv);
    const currentIdx = TIER_RULES.findIndex((r) => r.tier === current.tier);
    if (currentIdx === -1 || currentIdx === TIER_RULES.length - 1) return null;
    const next = TIER_RULES[currentIdx + 1];
    const safe = Math.max(0, next.minGmvCny - gmv);
    return { next, gmvNeededToNextCny: safe };
}

/**
 * `true` when `newGmv` crosses into a higher tier than `oldGmv`. Used by
 * the commission hook to decide whether to write an AnalyticsEvent
 * `reseller_tier_upgraded` audit row + update Reseller.tier in the same tx.
 */
export function isTierUpgrade(
    oldGmvCny: Prisma.Decimal | number,
    newGmvCny: Prisma.Decimal | number,
): { upgraded: false } | { upgraded: true; from: ResellerTierKey; to: ResellerTierKey } {
    const oldTier = tierForGmv(oldGmvCny).tier;
    const newTier = tierForGmv(newGmvCny).tier;
    if (oldTier === newTier) return { upgraded: false };
    return { upgraded: true, from: oldTier, to: newTier };
}

/**
 * PR-U1 — attribution window helper.
 *
 * 24-month protection from brief.
 */
import { describe, expect, it } from 'vitest';
import { ATTRIBUTION_WINDOW_MONTHS, computeAttributionExpiry } from '@/lib/reseller/attribution';

describe('computeAttributionExpiry', () => {
    it(`window = ${ATTRIBUTION_WINDOW_MONTHS} months`, () => {
        expect(ATTRIBUTION_WINDOW_MONTHS).toBe(24);
    });

    it('adds 24 UTC months', () => {
        const reg = new Date('2026-05-11T10:00:00.000Z');
        const exp = computeAttributionExpiry(reg);
        // May 2026 + 24 months = May 2028 (same day-of-month, same time)
        expect(exp.getUTCFullYear()).toBe(2028);
        expect(exp.getUTCMonth()).toBe(4); // May (0-indexed)
        expect(exp.getUTCDate()).toBe(11);
        expect(exp.getUTCHours()).toBe(10);
    });

    it('handles year rollover correctly', () => {
        // Jan 2025 + 24mo = Jan 2027
        const reg = new Date('2025-01-15T00:00:00.000Z');
        const exp = computeAttributionExpiry(reg);
        expect(exp.getUTCFullYear()).toBe(2027);
        expect(exp.getUTCMonth()).toBe(0); // January
        expect(exp.getUTCDate()).toBe(15);
    });

    it('defaults to now() when no argument', () => {
        const before = Date.now();
        const exp = computeAttributionExpiry();
        const after = Date.now();
        // Should be 24mo from "now" — approximate window check.
        // 24 months ≈ 730-732 days; pad to be safe.
        const ms24mo = 730 * 24 * 60 * 60 * 1_000;
        const diff = exp.getTime() - (before + after) / 2;
        expect(diff).toBeGreaterThan(ms24mo - 86_400_000);
        expect(diff).toBeLessThan(ms24mo + 5 * 86_400_000);
    });
});

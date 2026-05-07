/**
 * W7 promo-window boundary tests.
 *
 * The window is anchored at UTC+8: inclusive `2026-05-07 00:00` through
 * inclusive `2026-06-07 23:59:59.999` (W7 D4 PR-MN shift — was 5/8–6/7
 * pre-shift, before that 5/10–6/9). We probe each boundary +/- 1ms (and
 * +/- 1s for sanity) so any timezone slip in `isPromoActive` shows up.
 *
 * Brief-required boundary table (PR-MN):
 *   2026-05-06 23:59:59 UTC+8 → false
 *   2026-05-07 00:00:00 UTC+8 → true
 *   2026-06-07 23:59:59 UTC+8 → true
 *   2026-06-08 00:00:00 UTC+8 → false
 */
import { describe, expect, it } from 'vitest';
import {
    PROMO_END_EXCLUSIVE,
    PROMO_START,
    getPromoEndDate,
    isPromoActive,
} from './promo';

describe('isPromoActive — boundary cases (PR-MN shift: 5/7–6/7)', () => {
    it('is INACTIVE one second before promo start (5/6 23:59:59 UTC+8)', () => {
        const just_before = new Date('2026-05-06T23:59:59+08:00');
        expect(isPromoActive(just_before)).toBe(false);
    });

    it('is INACTIVE one millisecond before promo start', () => {
        const t = new Date(PROMO_START.getTime() - 1);
        expect(isPromoActive(t)).toBe(false);
    });

    it('is ACTIVE at the exact promo start instant (5/7 00:00:00.000 UTC+8)', () => {
        expect(isPromoActive(new Date(PROMO_START.getTime()))).toBe(true);
    });

    it('is ACTIVE one millisecond after start', () => {
        expect(isPromoActive(new Date(PROMO_START.getTime() + 1))).toBe(true);
    });

    it('is ACTIVE during the window (mid-promo, 5/22 12:00 UTC+8)', () => {
        expect(isPromoActive(new Date('2026-05-22T12:00:00+08:00'))).toBe(true);
    });

    it('is ACTIVE on the last inclusive instant (6/7 23:59:59.999 UTC+8)', () => {
        expect(isPromoActive(new Date('2026-06-07T23:59:59.999+08:00'))).toBe(true);
    });

    it('is ACTIVE one millisecond before exclusive end', () => {
        expect(isPromoActive(new Date(PROMO_END_EXCLUSIVE.getTime() - 1))).toBe(true);
    });

    it('is INACTIVE at the exact exclusive-end instant (6/8 00:00:00.000 UTC+8)', () => {
        expect(isPromoActive(new Date(PROMO_END_EXCLUSIVE.getTime()))).toBe(false);
    });

    it('is INACTIVE one second after exclusive end (6/8 00:00:01 UTC+8)', () => {
        expect(isPromoActive(new Date('2026-06-08T00:00:01+08:00'))).toBe(false);
    });

    it('is INACTIVE well after the window (2026-07-01)', () => {
        expect(isPromoActive(new Date('2026-07-01T00:00:00+08:00'))).toBe(false);
    });

    it('is INACTIVE well before the window (2026-04-01)', () => {
        expect(isPromoActive(new Date('2026-04-01T00:00:00+08:00'))).toBe(false);
    });

    it('treats UTC and UTC+8 as the same instant (no timezone bug)', () => {
        // 2026-05-07 00:00 UTC+8 == 2026-05-06 16:00 UTC. Both must be active.
        expect(isPromoActive(new Date('2026-05-07T00:00:00+08:00'))).toBe(true);
        expect(isPromoActive(new Date('2026-05-06T16:00:00Z'))).toBe(true);
    });
});

describe('getPromoEndDate', () => {
    it('returns 2026-06-07 23:59:59.999 UTC+8 (last inclusive instant)', () => {
        const end = getPromoEndDate();
        // Same instant as 2026-06-07T23:59:59.999+08:00.
        expect(end.toISOString()).toBe(
            new Date('2026-06-07T23:59:59.999+08:00').toISOString(),
        );
    });

    it('is 1ms before PROMO_END_EXCLUSIVE', () => {
        expect(getPromoEndDate().getTime()).toBe(PROMO_END_EXCLUSIVE.getTime() - 1);
    });
});

describe('promo window total length', () => {
    it('spans exactly 32 days (5/7 to 6/8 exclusive — PR-MN extended +1 day)', () => {
        const ms = PROMO_END_EXCLUSIVE.getTime() - PROMO_START.getTime();
        const days = ms / (1000 * 60 * 60 * 24);
        expect(days).toBe(32);
    });
});

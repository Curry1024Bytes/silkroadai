import { describe, expect, it } from 'vitest';
import { deriveTierRows, tierOrder } from '@/lib/admin/pricing-tiers';

const price = (tier: string, extra: Record<string, unknown> = {}) => ({ tier, ...extra });

describe('tierOrder', () => {
    it('pool < official < other', () => {
        expect(tierOrder('pool')).toBe(0);
        expect(tierOrder('official')).toBe(1);
        expect(tierOrder('whatever')).toBe(2);
    });
});

describe('deriveTierRows', () => {
    it('upstream_map {pool, official}, no prices → 2 unpriced rows (pool then official)', () => {
        const rows = deriveTierRows({ upstream_map: { pool: {}, official: {} }, prices: [] });
        expect(rows.map((r) => r.tier)).toEqual(['pool', 'official']);
        expect(rows.every((r) => r.current === null)).toBe(true);
    });

    it('orders pool before official regardless of upstream_map key order', () => {
        const rows = deriveTierRows({ upstream_map: { official: {}, pool: {} }, prices: [] });
        expect(rows.map((r) => r.tier)).toEqual(['pool', 'official']);
    });

    it('pool priced + official unpriced → pool.current set, official.current null', () => {
        const poolPrice = price('pool', { id: 'p1' });
        const rows = deriveTierRows({ upstream_map: { pool: {}, official: {} }, prices: [poolPrice] });
        const byTier = Object.fromEntries(rows.map((r) => [r.tier, r]));
        expect(byTier.pool.current).toBe(poolPrice);
        expect(byTier.official.current).toBeNull();
    });

    it('current = newest price per tier (prices arrive DESC by effective_from → first wins)', () => {
        const newest = price('pool', { id: 'new' });
        const older = price('pool', { id: 'old' });
        const rows = deriveTierRows({ upstream_map: { pool: {} }, prices: [newest, older] });
        expect(rows).toHaveLength(1);
        expect(rows[0].current).toBe(newest);
    });

    it('empty / missing / non-object upstream_map with no prices → no invented pool row', () => {
        expect(deriveTierRows({ upstream_map: {}, prices: [] })).toEqual([]);
        expect(deriveTierRows({ upstream_map: null, prices: [] })).toEqual([]);
        expect(deriveTierRows({ upstream_map: ['x'], prices: [] })).toEqual([]);
    });

    it('empty upstream_map hides historical price-only tiers from editable rows', () => {
        const historical = price('legacy-tier', { id: 'historical' });
        expect(deriveTierRows({ upstream_map: {}, prices: [historical] })).toEqual([]);
    });

    it('legacy price residue stays historical and does not create an editable row', () => {
        const legacy = price('default', { id: 'legacy' });
        const rows = deriveTierRows({ upstream_map: { pool: {} }, prices: [legacy] });
        expect(rows).toEqual([{ tier: 'pool', current: null }]);
    });
});

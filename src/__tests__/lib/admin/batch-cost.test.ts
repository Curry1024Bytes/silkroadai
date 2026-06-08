import { describe, expect, it } from 'vitest';
import { computeBatchCost, costFraction, round4, toNum, type BatchModelLike } from '@/lib/admin/batch-cost';

// Reusable sample family (anthropic): a single-tier chat model, a two-tier chat model,
// an image model (per_image base), and an unpriced model (skipped).
const opus: BatchModelLike = {
    id: 'm-opus',
    slug: 'claude-opus-4-8',
    display_name: 'Claude Opus 4.8',
    modality: 'chat',
    upstream_map: { pool: { channel_id: 2, upstream_model: 'claude-opus-4-8' } },
    prices: [
        // current (DESC) first; older row second (proves we read the latest).
        { tier: 'pool', input_cny_per_1m: 6.5, output_cny_per_1m: 32.5, per_image_cny: null, cost_cny_per_1m: null },
        { tier: 'pool', input_cny_per_1m: 5, output_cny_per_1m: 25, per_image_cny: null, cost_cny_per_1m: null },
    ],
};
const sonnet: BatchModelLike = {
    id: 'm-sonnet',
    slug: 'claude-sonnet-4-8',
    display_name: 'Claude Sonnet 4.8',
    modality: 'chat',
    upstream_map: { pool: {}, official: {} },
    prices: [
        { tier: 'pool', input_cny_per_1m: 13, output_cny_per_1m: 65, per_image_cny: null, cost_cny_per_1m: 1 },
        { tier: 'official', input_cny_per_1m: 26, output_cny_per_1m: 130, per_image_cny: null, cost_cny_per_1m: null },
    ],
};
const image: BatchModelLike = {
    id: 'm-img',
    slug: 'gemini-3-pro-image',
    display_name: 'Gemini Image',
    modality: 'image',
    upstream_map: { pool: {} },
    prices: [
        { tier: 'pool', input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: 0.3, cost_cny_per_1m: null },
    ],
};
const unpriced: BatchModelLike = {
    id: 'm-haiku',
    slug: 'claude-haiku-4-8',
    display_name: 'Claude Haiku 4.8',
    modality: 'chat',
    upstream_map: { pool: {} },
    prices: [],
};

const RATIOS = { costRatio: 0.15, retailRatio: 1.3 }; // Claude 乙案

describe('batch-cost helpers', () => {
    it('costFraction = costRatio / retailRatio', () => {
        expect(costFraction(0.15, 1.3)).toBe(0.15 / 1.3);
        expect(costFraction(0.15, 1.3)).toBeCloseTo(0.1154, 4);
    });

    it('round4 rounds to 4 dp', () => {
        expect(round4(0.0346153)).toBe(0.0346);
        expect(round4(0.75)).toBe(0.75);
    });

    it('toNum coerces string|number|null', () => {
        expect(toNum('6.5')).toBe(6.5);
        expect(toNum(0.3)).toBe(0.3);
        expect(toNum(null)).toBeNull();
        expect(toNum('')).toBeNull();
    });
});

describe('computeBatchCost', () => {
    it('chat model pins input retail: opus 6.5 × 0.15/1.3 = ¥0.75', () => {
        const r = computeBatchCost([opus], RATIOS);
        expect(r.affected).toBe(1);
        expect(r.skipped).toBe(0);
        const row = r.rows[0];
        expect(row).toMatchObject({ model_id: 'm-opus', tier: 'pool', base: 'input', retail: 6.5, newCost: 0.75 });
        // new version row copies the current retail fields
        expect(row.copy).toEqual({ input_cny_per_1m: 6.5, output_cny_per_1m: 32.5, per_image_cny: null });
    });

    it('multi-tier: each tier uses its own input retail', () => {
        const r = computeBatchCost([sonnet], RATIOS);
        const byTier = Object.fromEntries(r.rows.map((x) => [x.tier, x]));
        expect(byTier.pool.newCost).toBe(1.5); // 13 × 0.15/1.3
        expect(byTier.pool.oldCost).toBe(1); // existing cost surfaced (改前)
        expect(byTier.official.newCost).toBe(3); // 26 × 0.15/1.3
        expect(r.affected).toBe(2);
    });

    it('tier filter restricts to the chosen tier', () => {
        const r = computeBatchCost([sonnet], { ...RATIOS, tier: 'official' });
        expect(r.rows).toHaveLength(1);
        expect(r.rows[0]).toMatchObject({ tier: 'official', newCost: 3 });
    });

    it('image model uses per_image as the base', () => {
        const r = computeBatchCost([image], RATIOS);
        expect(r.rows[0]).toMatchObject({ base: 'per_image', retail: 0.3, newCost: 0.0346 });
        expect(r.rows[0].copy).toEqual({ input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: 0.3 });
    });

    it('models with no retail price are skipped (not written)', () => {
        const r = computeBatchCost([unpriced], RATIOS);
        expect(r.affected).toBe(0);
        expect(r.skipped).toBe(1);
        expect(r.rows[0]).toMatchObject({ tier: 'pool', skipped: true, retail: null, newCost: null, copy: null });
    });

    it('whole family: affected vs skipped tallies are correct', () => {
        const r = computeBatchCost([opus, sonnet, image, unpriced], RATIOS);
        expect(r.affected).toBe(4); // opus + sonnet×2 + image
        expect(r.skipped).toBe(1); // unpriced
        expect(r.fraction).toBe(0.15 / 1.3);
    });
});

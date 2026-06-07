import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetChannel = vi.fn();
const mockUpdateChannel = vi.fn();
const mockGetOption = vi.fn();
const mockPutOption = vi.fn();

vi.mock('@/lib/newapi/client', () => ({
    getChannel: (...a: unknown[]) => mockGetChannel(...a),
    updateChannel: (...a: unknown[]) => mockUpdateChannel(...a),
    getOption: (...a: unknown[]) => mockGetOption(...a),
    putOption: (...a: unknown[]) => mockPutOption(...a),
}));

import {
    computeRatios,
    retailFromRatios,
    syncModelPriceToNewApi,
    resolveImageModelPrice,
    PRICING_FX,
} from '@/lib/newapi/pricing-sync';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('computeRatios (pinned to scripts/apply-new-pricing-2026-05-21.mjs)', () => {
    it('uses FX = 7 (NOT quota-units USD_TO_CNY_RATE 7.2)', () => {
        expect(PRICING_FX).toBe(7);
    });

    it('gpt-5.4 retail ¥2.5 in / ¥10 out → mr 0.357143, cr 4', () => {
        // official $5/$20 × ¥0.5/$1 discount = retail ¥2.5/¥10. mr = 2.5/7.
        expect(computeRatios(2.5, 10)).toEqual({ model_ratio: 0.357143, completion_ratio: 4 });
    });

    it('claude opus retail ¥22.5 in / ¥112.5 out → mr 3.214286, cr 5', () => {
        // official $15/$75 × ¥1.5/$1 = retail ¥22.5/¥112.5. mr = 22.5/7.
        expect(computeRatios(22.5, 112.5)).toEqual({ model_ratio: 3.214286, completion_ratio: 5 });
    });

    it('cnyIn = 0 → cr defaults to 1 (no divide-by-zero)', () => {
        expect(computeRatios(0, 0)).toEqual({ model_ratio: 0, completion_ratio: 1 });
    });
});

describe('retailFromRatios (P2.5 reverse derivation — inverse of computeRatios)', () => {
    it('gpt-5.4: mr 0.357143, cr 4 → ¥2.5 in / ¥10 out', () => {
        expect(retailFromRatios(0.357143, 4)).toEqual({ input_cny_per_1m: 2.5, output_cny_per_1m: 10 });
    });

    it('claude opus: mr 3.214286, cr 5 → ¥22.5 in / ¥112.5 out', () => {
        expect(retailFromRatios(3.214286, 5)).toEqual({ input_cny_per_1m: 22.5, output_cny_per_1m: 112.5 });
    });

    it('completion_ratio = 1 → in = out', () => {
        expect(retailFromRatios(0.5, 1)).toEqual({ input_cny_per_1m: 3.5, output_cny_per_1m: 3.5 });
    });

    // The whole point: import (retailFromRatios) must undo sync (computeRatios), so a
    // round-trip lands back on the operator's retail price. Both directions pinned to FX=7.
    it.each([
        [2.5, 10],
        [22.5, 112.5],
        [1.5, 7.5],
        [0.5, 0.5],
    ])('round-trips ¥%s in / ¥%s out through computeRatios → retailFromRatios', (cnyIn, cnyOut) => {
        const r = computeRatios(cnyIn, cnyOut);
        expect(retailFromRatios(r.model_ratio, r.completion_ratio)).toEqual({
            input_cny_per_1m: cnyIn,
            output_cny_per_1m: cnyOut,
        });
    });
});

describe('syncModelPriceToNewApi', () => {
    const UPSTREAM = { default: { channel_id: 3, upstream_model: 'gpt-5.4' } };

    it('tier not in upstream_map → ok:false, never calls new-api', async () => {
        const r = await syncModelPriceToNewApi(UPSTREAM, {
            tier: 'official',
            input_cny_per_1m: 2.5,
            output_cny_per_1m: 10,
        });
        expect(r.ok).toBe(false);
        expect(r.error).toContain('official');
        expect(mockGetChannel).not.toHaveBeenCalled();
        expect(mockUpdateChannel).not.toHaveBeenCalled();
    });

    it('no in/out price AND no per_image → skipped (nothing to sync), never calls new-api', async () => {
        const r = await syncModelPriceToNewApi(UPSTREAM, {
            tier: 'default',
            input_cny_per_1m: null,
            output_cny_per_1m: null,
        });
        expect(r.ok).toBe(true);
        expect(r.skipped).toBeTruthy();
        expect(mockGetChannel).not.toHaveBeenCalled();
        expect(mockGetOption).not.toHaveBeenCalled();
    });

    it('merges mr/cr into the channel and PUTs the WHOLE object (gotcha #15)', async () => {
        mockGetChannel.mockResolvedValue({
            id: 3,
            name: 'sub2api OpenAI',
            model_ratio: JSON.stringify({ 'other-model': 1.0 }),
            completion_ratio: JSON.stringify({ 'other-model': 2.0 }),
            models: 'gpt-5.4,other-model',
            model_mapping: JSON.stringify({ short: 'gpt-5.4' }),
        });
        mockUpdateChannel.mockResolvedValue(undefined);

        const r = await syncModelPriceToNewApi(UPSTREAM, {
            tier: 'default',
            input_cny_per_1m: 2.5,
            output_cny_per_1m: 10,
        });

        expect(r.ok).toBe(true);
        expect(r.ratios).toEqual({ model_ratio: 0.357143, completion_ratio: 4 });

        const put = mockUpdateChannel.mock.calls[0][0];
        // gotcha #15: the whole channel object must be PUT back — models /
        // model_mapping must survive, or new-api silently clears them.
        expect(put.models).toBe('gpt-5.4,other-model');
        expect(put.model_mapping).toBe(JSON.stringify({ short: 'gpt-5.4' }));
        // our SKU merged on top of the pre-existing entry (not replacing the dict).
        expect(JSON.parse(put.model_ratio)).toEqual({ 'other-model': 1.0, 'gpt-5.4': 0.357143 });
        expect(JSON.parse(put.completion_ratio)).toEqual({ 'other-model': 2.0, 'gpt-5.4': 4 });
    });

    it('handles an already-parsed dict (model_ratio as object, not JSON string)', async () => {
        mockGetChannel.mockResolvedValue({ id: 3, model_ratio: { x: 1 }, completion_ratio: { x: 2 } });
        mockUpdateChannel.mockResolvedValue(undefined);
        const r = await syncModelPriceToNewApi(UPSTREAM, {
            tier: 'default',
            input_cny_per_1m: 2.5,
            output_cny_per_1m: 10,
        });
        expect(r.ok).toBe(true);
        expect(JSON.parse(mockUpdateChannel.mock.calls[0][0].model_ratio)).toEqual({ x: 1, 'gpt-5.4': 0.357143 });
    });

    it('new-api failure → ok:false with error, ratios still computed', async () => {
        mockGetChannel.mockRejectedValue(new Error('502 upstream'));
        const r = await syncModelPriceToNewApi(UPSTREAM, {
            tier: 'default',
            input_cny_per_1m: 2.5,
            output_cny_per_1m: 10,
        });
        expect(r.ok).toBe(false);
        expect(r.error).toContain('502');
        expect(r.ratios).toEqual({ model_ratio: 0.357143, completion_ratio: 4 });
        expect(mockUpdateChannel).not.toHaveBeenCalled();
    });
});

describe('syncModelPriceToNewApi — image models → global ModelPrice (P2.8 Part B)', () => {
    const IMG = { pool: { channel_id: 17, upstream_model: 'gpt-image-2' } };

    it('per_image ¥0.10 → ModelPrice $0.01429 (= /7); GET-merge-PUT WHOLE dict (preserves others)', async () => {
        // discovery-pinned: live new-api ModelPrice[gpt-image-2] = 0.01429 = ¥0.10/7.
        mockGetOption.mockResolvedValue(JSON.stringify({ 'dall-e-3': 0.04, 'other-img': 0.5 }));
        mockPutOption.mockResolvedValue(undefined);

        const r = await syncModelPriceToNewApi(IMG, {
            tier: 'pool',
            input_cny_per_1m: null,
            output_cny_per_1m: null,
            per_image_cny: 0.1,
        });

        expect(r.ok).toBe(true);
        expect(r.image).toBe(true);
        expect(r.modelPrice_usd).toBe(0.01429);
        expect(r.upstream_model).toBe('gpt-image-2');
        // brief B.2 pt3 + gotcha #15 spirit: PUT the whole ModelPrice dict, ours merged on top.
        expect(mockGetOption).toHaveBeenCalledWith('ModelPrice');
        const [key, value] = mockPutOption.mock.calls[0];
        expect(key).toBe('ModelPrice');
        expect(JSON.parse(value)).toEqual({ 'dall-e-3': 0.04, 'other-img': 0.5, 'gpt-image-2': 0.01429 });
        // never touches the per-channel mr/cr path (chat regression guard).
        expect(mockGetChannel).not.toHaveBeenCalled();
        expect(mockUpdateChannel).not.toHaveBeenCalled();
    });

    it('ModelPrice option absent (null) → starts a fresh dict', async () => {
        mockGetOption.mockResolvedValue(null);
        mockPutOption.mockResolvedValue(undefined);
        const r = await syncModelPriceToNewApi(
            { pool: { channel_id: 17, upstream_model: 'gemini-3-pro-image' } },
            { tier: 'pool', input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: 0.07 },
        );
        expect(r.ok).toBe(true);
        expect(JSON.parse(mockPutOption.mock.calls[0][1])).toEqual({ 'gemini-3-pro-image': 0.01 }); // 0.07/7
    });

    it('edited tier lacks a mapping → falls back to any tier upstream_model (image names are tier-agnostic)', async () => {
        mockGetOption.mockResolvedValue('{}');
        mockPutOption.mockResolvedValue(undefined);
        const r = await syncModelPriceToNewApi(IMG, {
            tier: 'official', // only 'pool' is mapped
            input_cny_per_1m: null,
            output_cny_per_1m: null,
            per_image_cny: 0.14,
        });
        expect(r.ok).toBe(true);
        expect(r.upstream_model).toBe('gpt-image-2'); // resolved from pool mapping
        expect(JSON.parse(mockPutOption.mock.calls[0][1])).toEqual({ 'gpt-image-2': 0.02 }); // 0.14/7
    });

    it('empty upstream_map → ok:false, image:true, never calls new-api', async () => {
        const r = await syncModelPriceToNewApi(
            {},
            { tier: 'pool', input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: 0.1 },
        );
        expect(r.ok).toBe(false);
        expect(r.image).toBe(true);
        expect(mockGetOption).not.toHaveBeenCalled();
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('option GET/PUT failure → ok:false image:true, modelPrice_usd still computed', async () => {
        mockGetOption.mockRejectedValue(new Error('502 option'));
        const r = await syncModelPriceToNewApi(IMG, {
            tier: 'pool',
            input_cny_per_1m: null,
            output_cny_per_1m: null,
            per_image_cny: 0.1,
        });
        expect(r.ok).toBe(false);
        expect(r.image).toBe(true);
        expect(r.modelPrice_usd).toBe(0.01429);
        expect(r.error).toContain('502');
    });
});

describe('resolveImageModelPrice (global ModelPrice is single-price — brief B.3)', () => {
    it('single priced tier → that tier, no warn', () => {
        expect(resolveImageModelPrice([{ tier: 'pool', per_image_cny: 0.1 }], 'pool')).toEqual({
            tier: 'pool',
            per_image_cny: 0.1,
        });
    });

    it('multi-tier SAME price → default tier, no warn', () => {
        const r = resolveImageModelPrice(
            [
                { tier: 'pool', per_image_cny: 0.1 },
                { tier: 'official', per_image_cny: 0.1 },
            ],
            'pool',
        );
        expect(r).toEqual({ tier: 'pool', per_image_cny: 0.1 });
    });

    it('multi-tier DIFFERENT price → uses default (pool) value + warns the rest is ignored', () => {
        const r = resolveImageModelPrice(
            [
                { tier: 'pool', per_image_cny: 0.1 },
                { tier: 'official', per_image_cny: 0.15 },
            ],
            'pool',
        );
        expect(r.tier).toBe('pool');
        expect(r.per_image_cny).toBe(0.1);
        expect(r.warn).toContain('pool');
    });

    it('default tier unpriced → falls back to first by tier order (no divergence → no warn)', () => {
        const r = resolveImageModelPrice(
            [
                { tier: 'pool', per_image_cny: null },
                { tier: 'official', per_image_cny: 0.15 },
            ],
            'pool',
        );
        expect(r.tier).toBe('official');
        expect(r.per_image_cny).toBe(0.15);
        expect(r.warn).toBeUndefined();
    });

    it('no tier priced → default tier + null (nothing to sync)', () => {
        expect(resolveImageModelPrice([{ tier: 'pool', per_image_cny: null }], 'pool')).toEqual({
            tier: 'pool',
            per_image_cny: null,
        });
    });

    it('honors a custom default tier key (not hardcoded "pool")', () => {
        const r = resolveImageModelPrice(
            [
                { tier: 'house', per_image_cny: 0.2 },
                { tier: 'official', per_image_cny: 0.3 },
            ],
            'house',
        );
        expect(r.tier).toBe('house');
        expect(r.per_image_cny).toBe(0.2);
        expect(r.warn).toContain('house');
    });
});

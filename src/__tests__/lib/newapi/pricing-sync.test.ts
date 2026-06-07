import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetChannel = vi.fn();
const mockUpdateChannel = vi.fn();

vi.mock('@/lib/newapi/client', () => ({
    getChannel: (...a: unknown[]) => mockGetChannel(...a),
    updateChannel: (...a: unknown[]) => mockUpdateChannel(...a),
}));

import { computeRatios, retailFromRatios, syncModelPriceToNewApi, PRICING_FX } from '@/lib/newapi/pricing-sync';

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

    it('image model (no in/out price) → skipped, never calls new-api', async () => {
        const r = await syncModelPriceToNewApi(UPSTREAM, {
            tier: 'default',
            input_cny_per_1m: null,
            output_cny_per_1m: null,
            per_image_cny: 0.5,
        });
        expect(r.ok).toBe(true);
        expect(r.skipped).toBeTruthy();
        expect(mockGetChannel).not.toHaveBeenCalled();
        expect(mockUpdateChannel).not.toHaveBeenCalled();
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

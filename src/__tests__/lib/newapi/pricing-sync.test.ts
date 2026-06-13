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
    resolveChatTierPrice,
    CHAT_FX,
    IMAGE_FX,
} from '@/lib/newapi/pricing-sync';
import { quotaToCny } from '@/lib/newapi/quota-units';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('computeRatios (FX calibrated to new-api actual billing — P4c-prereq 2026-06-08)', () => {
    // CHAT_FX = quotaToCny(1M) = (1e6/QUOTA_PER_USD)×USD_TO_CNY, env-derived (2026-06-12 fix:
    // was hardcoded 2×USD_TO_CNY which wrongly assumed QUOTA_PER_USD=500000; prod is 1e6 → 7).
    // Local test env (QUOTA_PER_USD=500000, USD_TO_CNY=7.2) → 14.4; prod (1e6/7) → 7.
    it('chat CHAT_FX = quotaToCny(1M) (local test env = 14.4); image IMAGE_FX = USD_TO_CNY = 7.2', () => {
        expect(CHAT_FX).toBe(quotaToCny(1_000_000));
        expect(CHAT_FX).toBe(14.4);
        expect(IMAGE_FX).toBe(7.2);
    });

    it('retail ¥2.5 in / ¥10 out → mr 0.173611 (= 2.5/14.4), cr 4', () => {
        expect(computeRatios(2.5, 10)).toEqual({ model_ratio: 0.173611, completion_ratio: 4 });
    });

    it('retail ¥22.5 in / ¥112.5 out → mr 1.5625 (= 22.5/14.4), cr 5', () => {
        expect(computeRatios(22.5, 112.5)).toEqual({ model_ratio: 1.5625, completion_ratio: 5 });
    });

    it('cnyIn = 0 → cr defaults to 1 (no divide-by-zero)', () => {
        expect(computeRatios(0, 0)).toEqual({ model_ratio: 0, completion_ratio: 1 });
    });
});

describe('retailFromRatios (P2.5 reverse derivation — inverse of computeRatios)', () => {
    it('mr 0.173611, cr 4 → ¥2.5 in / ¥10 out', () => {
        expect(retailFromRatios(0.173611, 4)).toEqual({ input_cny_per_1m: 2.5, output_cny_per_1m: 10 });
    });

    it('mr 1.5625, cr 5 → ¥22.5 in / ¥112.5 out', () => {
        expect(retailFromRatios(1.5625, 5)).toEqual({ input_cny_per_1m: 22.5, output_cny_per_1m: 112.5 });
    });

    it('completion_ratio = 1 → in = out (¥ = mr × 14.4)', () => {
        expect(retailFromRatios(0.5, 1)).toEqual({ input_cny_per_1m: 7.2, output_cny_per_1m: 7.2 });
    });

    // The whole point: import (retailFromRatios) must undo sync (computeRatios), so a
    // round-trip lands back on the operator's retail price. Both directions pinned to CHAT_FX=14.4.
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

describe('syncModelPriceToNewApi — chat models → global ModelRatio + CompletionRatio (P2.9)', () => {
    const UPSTREAM = { default: { channel_id: 3, upstream_model: 'gpt-5.4' } };

    // getOption keyed by option name (ModelRatio vs CompletionRatio dicts).
    const optionFixture =
        (mr: Record<string, number>, cr: Record<string, number>) =>
        (key: string): Promise<string | null> =>
            Promise.resolve(
                key === 'ModelRatio' ? JSON.stringify(mr) : key === 'CompletionRatio' ? JSON.stringify(cr) : null,
            );
    const putByKey = () => Object.fromEntries(mockPutOption.mock.calls.map(([k, v]) => [k, JSON.parse(v as string)]));

    it('merges into GLOBAL ModelRatio+CompletionRatio, PUTs WHOLE dict (others preserved); NO channel PUT', async () => {
        // P2.9: per-channel model_ratio PUT is silently dropped by new-api → bill from global options.
        mockGetOption.mockImplementation(optionFixture({ 'other-model': 1.0 }, { 'other-model': 2.0 }));
        mockPutOption.mockResolvedValue(undefined);

        const r = await syncModelPriceToNewApi(UPSTREAM, {
            tier: 'default',
            input_cny_per_1m: 2.5,
            output_cny_per_1m: 10,
        });

        expect(r.ok).toBe(true);
        expect(r.image).toBeFalsy(); // chat path, not image
        expect(r.ratios).toEqual({ model_ratio: 0.173611, completion_ratio: 4 });
        expect(r.upstream_model).toBe('gpt-5.4');
        // GETs both global option dicts...
        expect(mockGetOption).toHaveBeenCalledWith('ModelRatio');
        expect(mockGetOption).toHaveBeenCalledWith('CompletionRatio');
        // ...and PUTs both back whole, our SKU merged on top (pre-existing entries preserved).
        const put = putByKey();
        expect(put['ModelRatio']).toEqual({ 'other-model': 1.0, 'gpt-5.4': 0.173611 });
        expect(put['CompletionRatio']).toEqual({ 'other-model': 2.0, 'gpt-5.4': 4 });
        // the dropped per-channel path is gone entirely.
        expect(mockGetChannel).not.toHaveBeenCalled();
        expect(mockUpdateChannel).not.toHaveBeenCalled();
    });

    it('option absent (null) → starts fresh dicts', async () => {
        mockGetOption.mockResolvedValue(null);
        mockPutOption.mockResolvedValue(undefined);
        const r = await syncModelPriceToNewApi(UPSTREAM, {
            tier: 'default',
            input_cny_per_1m: 2.5,
            output_cny_per_1m: 10,
        });
        expect(r.ok).toBe(true);
        const put = putByKey();
        expect(put['ModelRatio']).toEqual({ 'gpt-5.4': 0.173611 });
        expect(put['CompletionRatio']).toEqual({ 'gpt-5.4': 4 });
    });

    it('edited tier lacks a mapping → falls back to any tier upstream_model (chat name is tier-agnostic)', async () => {
        mockGetOption.mockResolvedValue('{}');
        mockPutOption.mockResolvedValue(undefined);
        const r = await syncModelPriceToNewApi(UPSTREAM, {
            tier: 'official',
            input_cny_per_1m: 2.5,
            output_cny_per_1m: 10,
        });
        expect(r.ok).toBe(true);
        expect(r.upstream_model).toBe('gpt-5.4'); // resolved from the 'default' mapping
        expect(putByKey()['ModelRatio']).toEqual({ 'gpt-5.4': 0.173611 });
    });

    it('empty upstream_map → ok:false, never calls new-api', async () => {
        const r = await syncModelPriceToNewApi({}, { tier: 'default', input_cny_per_1m: 2.5, output_cny_per_1m: 10 });
        expect(r.ok).toBe(false);
        expect(mockGetOption).not.toHaveBeenCalled();
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('option GET/PUT failure → ok:false with error, ratios still computed', async () => {
        mockGetOption.mockRejectedValue(new Error('502 option'));
        const r = await syncModelPriceToNewApi(UPSTREAM, {
            tier: 'default',
            input_cny_per_1m: 2.5,
            output_cny_per_1m: 10,
        });
        expect(r.ok).toBe(false);
        expect(r.error).toContain('502');
        expect(r.ratios).toEqual({ model_ratio: 0.173611, completion_ratio: 4 });
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('no in/out price AND no per_image → skipped (nothing to sync), never calls new-api', async () => {
        const r = await syncModelPriceToNewApi(UPSTREAM, {
            tier: 'default',
            input_cny_per_1m: null,
            output_cny_per_1m: null,
        });
        expect(r.ok).toBe(true);
        expect(r.skipped).toBeTruthy();
        expect(mockGetOption).not.toHaveBeenCalled();
    });
});

describe('syncModelPriceToNewApi — image models → global ModelPrice (P2.8 Part B)', () => {
    const IMG = { pool: { channel_id: 17, upstream_model: 'gpt-image-2' } };

    it('per_image ¥0.10 → ModelPrice $0.01389 (= /7.2); GET-merge-PUT WHOLE dict (preserves others)', async () => {
        // ¥0.10 / IMAGE_FX(7.2) = 0.01389 (per-call USD). per_image here is an arbitrary unit-test value.
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
        expect(r.modelPrice_usd).toBe(0.01389);
        expect(r.upstream_model).toBe('gpt-image-2');
        // brief B.2 pt3 + gotcha #15 spirit: PUT the whole ModelPrice dict, ours merged on top.
        expect(mockGetOption).toHaveBeenCalledWith('ModelPrice');
        const [key, value] = mockPutOption.mock.calls[0];
        expect(key).toBe('ModelPrice');
        expect(JSON.parse(value)).toEqual({ 'dall-e-3': 0.04, 'other-img': 0.5, 'gpt-image-2': 0.01389 });
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
        expect(JSON.parse(mockPutOption.mock.calls[0][1])).toEqual({ 'gemini-3-pro-image': 0.00972 }); // 0.07/7.2
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
        expect(JSON.parse(mockPutOption.mock.calls[0][1])).toEqual({ 'gpt-image-2': 0.01944 }); // 0.14/7.2
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
        expect(r.modelPrice_usd).toBe(0.01389);
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

describe('resolveChatTierPrice (global ModelRatio is single-price — P2.9, mirrors image)', () => {
    const row = (tier: string, i: number | null, o: number | null) => ({
        tier,
        input_cny_per_1m: i,
        output_cny_per_1m: o,
    });

    it('single priced tier → that tier, no warn', () => {
        expect(resolveChatTierPrice([row('pool', 2.5, 10)], 'pool')).toEqual({
            tier: 'pool',
            input_cny_per_1m: 2.5,
            output_cny_per_1m: 10,
        });
    });

    it('multi-tier SAME (in,out) → default tier, no warn', () => {
        const r = resolveChatTierPrice([row('pool', 2.5, 10), row('official', 2.5, 10)], 'pool');
        expect(r).toEqual({ tier: 'pool', input_cny_per_1m: 2.5, output_cny_per_1m: 10 });
    });

    it('multi-tier DIFFERENT price → uses default (pool) value + warns the rest is ignored', () => {
        const r = resolveChatTierPrice([row('pool', 6.5, 32.5), row('official', 16, 80)], 'pool');
        expect(r.tier).toBe('pool');
        expect(r.input_cny_per_1m).toBe(6.5);
        expect(r.output_cny_per_1m).toBe(32.5);
        expect(r.warn).toContain('pool');
    });

    it('divergence in output only (same input) → still warns', () => {
        const r = resolveChatTierPrice([row('pool', 2.5, 10), row('official', 2.5, 12)], 'pool');
        expect(r.tier).toBe('pool');
        expect(r.warn).toBeTruthy();
    });

    it('default tier unpriced → falls back to first by tier order (no divergence → no warn)', () => {
        const r = resolveChatTierPrice([row('pool', null, null), row('official', 16, 80)], 'pool');
        expect(r.tier).toBe('official');
        expect(r.input_cny_per_1m).toBe(16);
        expect(r.output_cny_per_1m).toBe(80);
        expect(r.warn).toBeUndefined();
    });

    it('no tier priced → default tier + nulls (nothing to sync)', () => {
        expect(resolveChatTierPrice([row('pool', null, null)], 'pool')).toEqual({
            tier: 'pool',
            input_cny_per_1m: null,
            output_cny_per_1m: null,
        });
    });

    it('honors a custom default tier key (not hardcoded "pool")', () => {
        const r = resolveChatTierPrice([row('house', 2, 4), row('official', 3, 6)], 'house');
        expect(r.tier).toBe('house');
        expect(r.input_cny_per_1m).toBe(2);
        expect(r.warn).toContain('house');
    });
});

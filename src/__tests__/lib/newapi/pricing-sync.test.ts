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
// GR 原生语义:sync 内部经 getTierGroupRatio 查 channel_groups(tier → newapi_group)。
const mockChannelGroupFindFirst = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: { channelGroup: { findFirst: (...a: unknown[]) => mockChannelGroupFindFirst(...a) } },
}));

import {
    computeRatios,
    retailFromRatios,
    syncModelPriceToNewApi,
    resolveImageModelPrice,
    resolveChatTierPrice,
    getTierGroupRatio,
    CHAT_FX,
    IMAGE_FX,
} from '@/lib/newapi/pricing-sync';
import { quotaToCny } from '@/lib/newapi/quota-units';

beforeEach(() => {
    vi.clearAllMocks();
    // tier key → newapi_group:'pool' 档挂 default 组,其余同名(default→default、official→official)。
    mockChannelGroupFindFirst.mockImplementation((args: unknown) => {
        const key = (args as { where: { key: string } }).where.key;
        return Promise.resolve({ newapi_group: key === 'pool' ? 'default' : key });
    });
});

/** getOption 的 keyed fixture:GroupRatio 恒给(缺省全 1),其余 key 按传入表;没配的返 null。 */
const optionsByKey =
    (dicts: Record<string, unknown>, groupRatio: Record<string, number> = { default: 1, official: 1 }) =>
    (key: string): Promise<string | null> => {
        if (key === 'GroupRatio') return Promise.resolve(JSON.stringify(groupRatio));
        const d = dicts[key];
        return Promise.resolve(d == null ? null : JSON.stringify(d));
    };

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
        expect(computeRatios(2.5, 10, 1)).toEqual({ model_ratio: 0.173611, completion_ratio: 4 });
    });

    it('retail ¥22.5 in / ¥112.5 out → mr 1.5625 (= 22.5/14.4), cr 5', () => {
        expect(computeRatios(22.5, 112.5, 1)).toEqual({ model_ratio: 1.5625, completion_ratio: 5 });
    });

    it('cnyIn = 0 → cr defaults to 1 (no divide-by-zero)', () => {
        expect(computeRatios(0, 0, 1)).toEqual({ model_ratio: 0, completion_ratio: 1 });
    });

    // GR 原生语义:同一 ¥ 价在不同组倍率下换算出不同基准 mr(实扣 = mr × FX × GR 恒等)。
    it('divides by the group ratio (GR 原生语义): ¥2.5 @ GR=1.2 → mr 0.144676', () => {
        expect(computeRatios(2.5, 10, 1.2)).toEqual({ model_ratio: 0.144676, completion_ratio: 4 });
    });
    it('GR<1 (pool-gpt 0.2): ¥1 in → mr = 1/(14.4×0.2) = 0.347222', () => {
        expect(computeRatios(1, 6, 0.2)).toEqual({ model_ratio: 0.347222, completion_ratio: 6 });
    });
});

describe('retailFromRatios (P2.5 reverse derivation — inverse of computeRatios)', () => {
    it('mr 0.173611, cr 4 → ¥2.5 in / ¥10 out', () => {
        expect(retailFromRatios(0.173611, 4, 1)).toEqual({ input_cny_per_1m: 2.5, output_cny_per_1m: 10 });
    });

    it('mr 1.5625, cr 5 → ¥22.5 in / ¥112.5 out', () => {
        expect(retailFromRatios(1.5625, 5, 1)).toEqual({ input_cny_per_1m: 22.5, output_cny_per_1m: 112.5 });
    });

    it('completion_ratio = 1 → in = out (¥ = mr × 14.4)', () => {
        expect(retailFromRatios(0.5, 1, 1)).toEqual({ input_cny_per_1m: 7.2, output_cny_per_1m: 7.2 });
    });

    // The whole point: import (retailFromRatios) must undo sync (computeRatios), so a
    // round-trip lands back on the operator's retail price. Both directions pinned to CHAT_FX=14.4.
    it.each([
        [2.5, 10],
        [22.5, 112.5],
        [1.5, 7.5],
        [0.5, 0.5],
    ])('round-trips ¥%s in / ¥%s out through computeRatios → retailFromRatios', (cnyIn, cnyOut) => {
        const r = computeRatios(cnyIn, cnyOut, 1);
        expect(retailFromRatios(r.model_ratio, r.completion_ratio, 1)).toEqual({
            input_cny_per_1m: cnyIn,
            output_cny_per_1m: cnyOut,
        });
    });

    it('round-trips with a non-1 group ratio (GR=1.2)', () => {
        const r = computeRatios(6, 30, 1.2);
        expect(retailFromRatios(r.model_ratio, r.completion_ratio, 1.2)).toEqual({
            input_cny_per_1m: 6,
            output_cny_per_1m: 30,
        });
    });
});

describe('syncModelPriceToNewApi — chat models → global ModelRatio + CompletionRatio (P2.9)', () => {
    const UPSTREAM = { default: { channel_id: 3, upstream_model: 'gpt-5.4' } };

    const putByKey = () => Object.fromEntries(mockPutOption.mock.calls.map(([k, v]) => [k, JSON.parse(v as string)]));

    it('merges into GLOBAL ModelRatio+CompletionRatio, PUTs WHOLE dict (others preserved); NO channel PUT', async () => {
        // P2.9: per-channel model_ratio PUT is silently dropped by new-api → bill from global options.
        mockGetOption.mockImplementation(
            optionsByKey({ ModelRatio: { 'other-model': 1.0 }, CompletionRatio: { 'other-model': 2.0 } }),
        );
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
        mockGetOption.mockImplementation(optionsByKey({}));
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
        mockGetOption.mockImplementation(optionsByKey({}));
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
        mockGetOption.mockImplementation((key: string) =>
            key === 'GroupRatio'
                ? Promise.resolve('{"default":1,"official":1}')
                : Promise.reject(new Error('502 option')),
        );
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

    it('per_image ¥0.10 → ModelPrice 0.013889 (= /7.2/GR1); GET-merge-PUT WHOLE dict (preserves others)', async () => {
        // ¥0.10 / (IMAGE_FX 7.2 × GR 1) = 0.013889(6dp)。per_image here is an arbitrary unit-test value.
        mockGetOption.mockImplementation(optionsByKey({ ModelPrice: { 'dall-e-3': 0.04, 'other-img': 0.5 } }));
        mockPutOption.mockResolvedValue(undefined);

        const r = await syncModelPriceToNewApi(IMG, {
            tier: 'pool',
            input_cny_per_1m: null,
            output_cny_per_1m: null,
            per_image_cny: 0.1,
        });

        expect(r.ok).toBe(true);
        expect(r.image).toBe(true);
        expect(r.modelPrice_usd).toBe(0.013889);
        expect(r.upstream_model).toBe('gpt-image-2');
        // brief B.2 pt3 + gotcha #15 spirit: PUT the whole ModelPrice dict, ours merged on top.
        expect(mockGetOption).toHaveBeenCalledWith('ModelPrice');
        const [key, value] = mockPutOption.mock.calls[0];
        expect(key).toBe('ModelPrice');
        expect(JSON.parse(value)).toEqual({ 'dall-e-3': 0.04, 'other-img': 0.5, 'gpt-image-2': 0.013889 });
        // never touches the per-channel mr/cr path (chat regression guard).
        expect(mockGetChannel).not.toHaveBeenCalled();
        expect(mockUpdateChannel).not.toHaveBeenCalled();
    });

    it('ModelPrice option absent (null) → starts a fresh dict', async () => {
        mockGetOption.mockImplementation(optionsByKey({}));
        mockPutOption.mockResolvedValue(undefined);
        const r = await syncModelPriceToNewApi(
            { pool: { channel_id: 17, upstream_model: 'gemini-3-pro-image' } },
            { tier: 'pool', input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: 0.07 },
        );
        expect(r.ok).toBe(true);
        expect(JSON.parse(mockPutOption.mock.calls[0][1])).toEqual({ 'gemini-3-pro-image': 0.009722 }); // 0.07/7.2, 6dp
    });

    it('edited tier lacks a mapping → falls back to any tier upstream_model (image names are tier-agnostic)', async () => {
        mockGetOption.mockImplementation(optionsByKey({}));
        mockPutOption.mockResolvedValue(undefined);
        const r = await syncModelPriceToNewApi(IMG, {
            tier: 'official', // only 'pool' is mapped
            input_cny_per_1m: null,
            output_cny_per_1m: null,
            per_image_cny: 0.14,
        });
        expect(r.ok).toBe(true);
        expect(r.upstream_model).toBe('gpt-image-2'); // resolved from pool mapping
        expect(JSON.parse(mockPutOption.mock.calls[0][1])).toEqual({ 'gpt-image-2': 0.019444 }); // 0.14/7.2, 6dp
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
        mockGetOption.mockImplementation((key: string) =>
            key === 'GroupRatio'
                ? Promise.resolve('{"default":1,"official":1}')
                : Promise.reject(new Error('502 option')),
        );
        const r = await syncModelPriceToNewApi(IMG, {
            tier: 'pool',
            input_cny_per_1m: null,
            output_cny_per_1m: null,
            per_image_cny: 0.1,
        });
        expect(r.ok).toBe(false);
        expect(r.image).toBe(true);
        expect(r.modelPrice_usd).toBe(0.013889);
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

describe('getTierGroupRatio + sync 按组倍率换算(GR 原生语义 2026-07-20)', () => {
    const UPSTREAM = { default: { channel_id: 3, upstream_model: 'gpt-5.4' } };
    const putByKey = () => Object.fromEntries(mockPutOption.mock.calls.map(([k, v]) => [k, JSON.parse(v as string)]));

    it('getTierGroupRatio: tier key → channel_groups.newapi_group → GroupRatio 值', async () => {
        mockGetOption.mockImplementation(optionsByKey({}, { default: 1.2, 'pool-gpt': 0.2 }));
        await expect(getTierGroupRatio('pool')).resolves.toBe(1.2); // pool 档挂 default 组
    });

    it('getTierGroupRatio: 档未登记 channel_groups → throw', async () => {
        mockChannelGroupFindFirst.mockResolvedValue(null);
        mockGetOption.mockImplementation(optionsByKey({}));
        await expect(getTierGroupRatio('ghost')).rejects.toThrow('未在 channel_groups 登记');
    });

    it('getTierGroupRatio: GroupRatio 缺组 → throw', async () => {
        mockGetOption.mockImplementation(optionsByKey({}, { other: 1 }));
        await expect(getTierGroupRatio('official')).rejects.toThrow('缺组');
    });

    it('chat sync ÷ 组倍率:default 档 GR=1.2,¥6/¥30 → mr 0.347222(= 6/(14.4×1.2)),cr 5', async () => {
        mockGetOption.mockImplementation(optionsByKey({}, { default: 1.2 }));
        mockPutOption.mockResolvedValue(undefined);
        const r = await syncModelPriceToNewApi(UPSTREAM, {
            tier: 'default',
            input_cny_per_1m: 6,
            output_cny_per_1m: 30,
        });
        expect(r.ok).toBe(true);
        expect(r.group_ratio).toBe(1.2);
        expect(r.ratios).toEqual({ model_ratio: 0.347222, completion_ratio: 5 });
        expect(putByKey()['ModelRatio']).toEqual({ 'gpt-5.4': 0.347222 });
    });

    it('组倍率解析失败(档未登记)→ ok:false,绝不写 option', async () => {
        mockChannelGroupFindFirst.mockResolvedValue(null);
        mockGetOption.mockImplementation(optionsByKey({}));
        const r = await syncModelPriceToNewApi(UPSTREAM, {
            tier: 'default',
            input_cny_per_1m: 6,
            output_cny_per_1m: 30,
        });
        expect(r.ok).toBe(false);
        expect(r.error).toContain('channel_groups');
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('image sync ÷ 组倍率:image2 档 GR=1.2,¥0.10/张 → ModelPrice 0.011574(= 0.1/(7.2×1.2))', async () => {
        mockGetOption.mockImplementation(optionsByKey({ ModelPrice: {} }, { image2: 1.2 }));
        mockPutOption.mockResolvedValue(undefined);
        const r = await syncModelPriceToNewApi(
            { image2: { channel_id: 44, upstream_model: 'gemini-3.1-flash-image-preview' } },
            { tier: 'image2', input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: 0.1 },
        );
        expect(r.ok).toBe(true);
        expect(r.group_ratio).toBe(1.2);
        expect(r.modelPrice_usd).toBe(0.011574);
    });

    it('resolve* 传 ratiosByTier:各档价 ∝ 组倍率 → 无 warn;不成比例 → 点名', () => {
        const ratios = { pool: 1.2, official: 3.4 };
        // 成比例:官方档 = 基准 × (3.4/1.2)
        const ok = resolveChatTierPrice(
            [
                { tier: 'pool', input_cny_per_1m: 6, output_cny_per_1m: 30 },
                { tier: 'official', input_cny_per_1m: 17, output_cny_per_1m: 85 },
            ],
            'pool',
            ratios,
        );
        expect(ok.warn).toBeUndefined();
        // 不成比例:官方档偏离
        const bad = resolveChatTierPrice(
            [
                { tier: 'pool', input_cny_per_1m: 6, output_cny_per_1m: 30 },
                { tier: 'official', input_cny_per_1m: 20, output_cny_per_1m: 100 },
            ],
            'pool',
            ratios,
        );
        expect(bad.warn).toContain('official');
    });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/newapi/quota-units', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/newapi/quota-units')>()),
    QUOTA_PER_USD: 500_000,
    USD_TO_CNY_RATE: 1,
}));

import {
    GROUP_SETTING_KEY,
    catalogDiffs,
    catalogMatches,
    customerPrice,
    modelOptionState,
    planGroupRatioWrites,
    planModelWrites,
    planVideoTokenWrites,
    readBasePrice,
    unverifiedWrites,
    type BasePrice,
    type OptionWrite,
    type CatalogAmounts,
} from '@/lib/admin/pricing-simple-core';
import { buildTieredPricingExpression, parseTieredPricingExpression } from '@/lib/admin/pricing-tiered-expression';

const EXPR = 'billing_setting.billing_expr';
const MODE = 'billing_setting.billing_mode';

function options(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ModelRatio: JSON.stringify({ 'gpt-5.5': 2.5 }),
        CompletionRatio: JSON.stringify({ 'gpt-5.5': 8 }),
        ModelPrice: JSON.stringify({ 'img-1': 0.25 }),
        CacheRatio: JSON.stringify({ 'gpt-5.5': 0.1 }),
        CreateCacheRatio: JSON.stringify({}),
        [MODE]: JSON.stringify({}),
        [EXPR]: JSON.stringify({}),
        GroupRatio: JSON.stringify({ default: 1.2, vip: 1.2 }),
        [GROUP_SETTING_KEY]: JSON.stringify({ default: 1.2 }),
        ...overrides,
    };
}

function apply(source: Record<string, unknown>, writes: OptionWrite[]): Record<string, unknown> {
    const next = { ...source };
    for (const write of writes) next[write.key] = JSON.stringify(write.value);
    return next;
}

const twoTiers: Extract<BasePrice, { mode: 'tiered' }>['tiers'] = [
    {
        max_input_tokens: 200_000,
        max_inclusive: true,
        rates: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, cache_write_1h: null },
    },
    {
        max_input_tokens: null,
        max_inclusive: false,
        rates: { input: 6, output: 22.5, cache_read: 0.6, cache_write: 7.5, cache_write_1h: null },
    },
];

describe('buildTieredPricingExpression', () => {
    it('round-trips through the parser', () => {
        const expression = buildTieredPricingExpression(twoTiers);
        expect(expression).toBe(
            'len <= 200000 ? tier("base", p * 3 + c * 15 + cr * 0.3 + cc * 3.75) : tier("tier_2", p * 6 + c * 22.5 + cr * 0.6 + cc * 7.5)',
        );
        const parsed = parseTieredPricingExpression(expression);
        expect(parsed.tiers.map((tier) => [tier.max_input_tokens, tier.max_inclusive, tier.rates.input])).toEqual([
            [200_000, true, 3],
            [null, false, 6],
        ]);
    });

    it('refuses cache prices filled in only some tiers', () => {
        const mixed = [twoTiers[0], { ...twoTiers[1], rates: { ...twoTiers[1].rates, cache_read: null } }];
        expect(() => buildTieredPricingExpression(mixed)).toThrow('缓存价须在所有阶梯同时填写或同时留空');
    });

    it('requires only the last tier to be open-ended', () => {
        expect(() => buildTieredPricingExpression([{ ...twoTiers[0], max_input_tokens: null }, twoTiers[1]])).toThrow();
        expect(() => buildTieredPricingExpression([twoTiers[0]])).toThrow('只有最后一档');
    });
});

describe('readBasePrice', () => {
    it('keeps peak/off-peak formulas read-only: a base-price save would replace the whole formula', () => {
        const formula =
            'weekday("Asia/Shanghai") >= 1 && weekday("Asia/Shanghai") <= 5 && hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 18 ? tier("peak", p * 2 + c * 8) : tier("off_peak", p * 1 + c * 4)';
        const source = options({
            [MODE]: JSON.stringify({ ds: 'tiered_expr' }),
            [EXPR]: JSON.stringify({ ds: formula }),
        });
        for (const run of [
            () => readBasePrice(source, 'ds'),
            () =>
                planModelWrites(source, 'ds', {
                    mode: 'token',
                    input: 2,
                    output: 8,
                    cache_read: null,
                    cache_write: null,
                }),
            () =>
                planModelWrites(source, 'ds', {
                    mode: 'tiered',
                    tiers: [
                        {
                            max_input_tokens: null,
                            max_inclusive: false,
                            rates: { input: 2, output: 8, cache_read: null, cache_write: null, cache_write_1h: null },
                        },
                    ],
                }),
            () => planModelWrites(source, 'ds', { mode: 'per_call', price: 1 }),
        ])
            expect(run).toThrow(expect.objectContaining({ code: 'pricing_time_readonly' }));
    });
    it('keeps structured media rules out of the scalar editor and detects resolution-only changes', () => {
        const source = options({ ImageResolutionPrice: { 'img-1': { '1K': 0.5, '2K': 0.8, '4K': 1 } } });
        expect(() => readBasePrice(source, 'img-1')).toThrow('new-api');
        expect(() => planModelWrites(source, 'img-1', { mode: 'per_call', price: 1 })).toThrow('new-api');
        const quote: CatalogAmounts = {
            input_cny_per_1m: null,
            output_cny_per_1m: null,
            per_image_cny: null,
            billing_details: {
                version: 1,
                mode: 'media',
                unit: 'cny_per_image',
                default_price: null,
                resolution_prices: { '1K': 0.5, '2K': 0.8, '4K': 1 },
            },
        };
        expect(catalogDiffs(quote, structuredClone(quote))).toEqual([]);
        const changed = structuredClone(quote);
        if (changed.billing_details?.mode !== 'media') throw Error('wrong mode');
        changed.billing_details.resolution_prices['4K'] = 2;
        expect(catalogDiffs(quote, changed)).toEqual([
            { tier: null, field: 'billing_rule', catalog: null, expected: null },
        ]);
    });
    it('reads token prices in official $ per 1M', () => {
        expect(readBasePrice(options(), 'gpt-5.5')).toEqual({
            mode: 'token',
            input: 5,
            output: 40,
            cache_read: 0.5,
            cache_write: null,
        });
    });

    it('prefers a locked completion meta ratio', () => {
        const source = options({ CompletionRatioMeta: JSON.stringify({ 'gpt-5.5': { ratio: 4, locked: true } }) });
        expect(readBasePrice(source, 'gpt-5.5')).toMatchObject({ output: 20 });
    });

    it('reads per-call and tiered prices, and null when unpriced', () => {
        expect(readBasePrice(options(), 'img-1')).toEqual({ mode: 'per_call', price: 0.25 });
        const tiered = options({
            [MODE]: JSON.stringify({ 'img-1': 'tiered_expr' }),
            [EXPR]: JSON.stringify({ 'img-1': buildTieredPricingExpression(twoTiers) }),
        });
        expect(readBasePrice(tiered, 'img-1')).toEqual({ mode: 'tiered', tiers: twoTiers });
        expect(readBasePrice(options(), 'unknown')).toBeNull();
    });
});

describe('planModelWrites', () => {
    it('writes only changed token entries and verifies against readback', () => {
        const source = options();
        const writes = planModelWrites(source, 'gpt-5.5', {
            mode: 'token',
            input: 5,
            output: 30,
            cache_read: 0.5,
            cache_write: null,
        });
        expect(writes.map((write) => [write.key, write.target])).toEqual([['CompletionRatio', 6]]);
        const after = apply(source, writes);
        expect(unverifiedWrites(after, writes)).toEqual([]);
        expect(unverifiedWrites(source, writes)).toEqual(['CompletionRatio']);
        expect(readBasePrice(after, 'gpt-5.5')).toMatchObject({ output: 30 });
    });

    it('deletes the cache ratio when the cache price is cleared', () => {
        const writes = planModelWrites(options(), 'gpt-5.5', {
            mode: 'token',
            input: 5,
            output: 40,
            cache_read: null,
            cache_write: null,
        });
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ key: 'CacheRatio', target: undefined });
        expect(writes[0].value).not.toHaveProperty('gpt-5.5');
    });

    it('switches per-call to token by adding ratios before removing ModelPrice', () => {
        const writes = planModelWrites(options(), 'img-1', {
            mode: 'token',
            input: 2,
            output: 8,
            cache_read: null,
            cache_write: null,
        });
        expect(writes.map((write) => write.key)).toEqual(['ModelRatio', 'CompletionRatio', 'ModelPrice']);
        expect(writes[0].target).toBe(1);
        expect(writes[2].target).toBeUndefined();
    });

    it('switches token to tiered: expression before mode, both after the ratio already exists', () => {
        const source = options();
        const writes = planModelWrites(source, 'gpt-5.5', { mode: 'tiered', tiers: twoTiers });
        expect(writes.map((write) => write.key)).toEqual([EXPR, MODE]);
        expect(readBasePrice(apply(source, writes), 'gpt-5.5')).toEqual({ mode: 'tiered', tiers: twoTiers });
    });

    it('switches tiered back to token and removes the mode then the expression last', () => {
        const source = options({
            [MODE]: JSON.stringify({ 'gpt-5.5': 'tiered_expr' }),
            [EXPR]: JSON.stringify({ 'gpt-5.5': buildTieredPricingExpression(twoTiers) }),
        });
        const writes = planModelWrites(source, 'gpt-5.5', {
            mode: 'token',
            input: 5,
            output: 40,
            cache_read: 0.5,
            cache_write: null,
        });
        expect(writes.map((write) => write.key)).toEqual([MODE, EXPR]);
    });

    it('refuses a token output that contradicts a locked completion ratio', () => {
        const source = options({ CompletionRatioMeta: JSON.stringify({ 'gpt-5.5': { ratio: 8, locked: true } }) });
        expect(() =>
            planModelWrites(source, 'gpt-5.5', {
                mode: 'token',
                input: 5,
                output: 30,
                cache_read: null,
                cache_write: null,
            }),
        ).toThrow(expect.objectContaining({ code: 'pricing_completion_locked' }));
    });

    it('refuses tiered pricing when new-api has no billing_setting options', () => {
        const source = options();
        delete source[MODE];
        expect(() => planModelWrites(source, 'gpt-5.5', { mode: 'tiered', tiers: twoTiers })).toThrow(
            expect.objectContaining({ code: 'pricing_tiered_unsupported' }),
        );
    });

    it('changes the optimistic-lock state whenever a pricing entry changes', () => {
        const source = options();
        const writes = planModelWrites(source, 'gpt-5.5', {
            mode: 'token',
            input: 6,
            output: 48,
            cache_read: 0.6,
            cache_write: null,
        });
        expect(modelOptionState(apply(source, writes), 'gpt-5.5')).not.toBe(modelOptionState(source, 'gpt-5.5'));
        expect(modelOptionState(source, 'gpt-5.5')).toBe(modelOptionState(options(), 'gpt-5.5'));
    });
});

describe('planGroupRatioWrites', () => {
    it('writes GroupRatio and the group_ratio_setting copy when present', () => {
        const writes = planGroupRatioWrites(options(), 'default', 2.4);
        expect(writes.map((write) => write.key)).toEqual(['GroupRatio', GROUP_SETTING_KEY]);
        expect(writes.every((write) => write.target === 2.4)).toBe(true);
    });

    it('mirrors the complete GroupRatio into a diverged group_ratio_setting copy', () => {
        const writes = planGroupRatioWrites(options(), 'vip', 2);
        expect(writes.map((write) => write.key)).toEqual(['GroupRatio', GROUP_SETTING_KEY]);
        expect(writes[1].value).toEqual({ default: 1.2, vip: 2 });
    });

    it('heals a diverged copy even when the ratio is unchanged', () => {
        const writes = planGroupRatioWrites(options(), 'default', 1.2);
        expect(writes.map((write) => write.key)).toEqual([GROUP_SETTING_KEY]);
        expect(writes[0].value).toEqual({ default: 1.2, vip: 1.2 });
    });

    it("leaves new-api's compiled-in default copy alone", () => {
        const pristine = options({ [GROUP_SETTING_KEY]: JSON.stringify({ default: 1, svip: 1, vip: 1 }) });
        expect(planGroupRatioWrites(pristine, 'default', 2.4).map((write) => write.key)).toEqual(['GroupRatio']);
    });

    it('is empty when unchanged and rejects nonsense ratios', () => {
        const consistent = options({ [GROUP_SETTING_KEY]: JSON.stringify({ default: 1.2, vip: 1.2 }) });
        expect(planGroupRatioWrites(consistent, 'default', 1.2)).toEqual([]);
        expect(() => planGroupRatioWrites(options(), 'default', 0)).toThrow(
            expect.objectContaining({ code: 'pricing_ratio_invalid' }),
        );
    });
});

describe('customerPrice / catalogMatches', () => {
    it('multiplies token base price by the group ratio', () => {
        const price = customerPrice({ mode: 'token', input: 5, output: 40, cache_read: null, cache_write: null }, 1.2);
        expect(price).toEqual({
            input_cny_per_1m: 6,
            output_cny_per_1m: 48,
            per_image_cny: null,
            billing_details: null,
        });
    });

    it('prices per call', () => {
        expect(customerPrice({ mode: 'per_call', price: 0.25 }, 1.2).per_image_cny).toBe(0.3);
    });

    it('emits tier details with derived bounds', () => {
        const price = customerPrice({ mode: 'tiered', tiers: twoTiers }, 2);
        expect(price.input_cny_per_1m).toBe(6);
        expect(
            price.billing_details?.tiers.map((tier) => [tier.name, tier.min_input_tokens, tier.min_inclusive]),
        ).toEqual([
            ['base', null, false],
            ['tier_2', 200_000, false],
        ]);
        expect(price.billing_details?.tiers[1].rates.output).toBe(45);
    });

    it('matches scalars within rounding and compares details only when they matter', () => {
        const expected = customerPrice(
            { mode: 'token', input: 5, output: 40, cache_read: null, cache_write: null },
            1.2,
        );
        expect(catalogMatches({ ...expected, input_cny_per_1m: 6.00001 }, expected)).toBe(true);
        expect(catalogMatches({ ...expected, input_cny_per_1m: 6.1 }, expected)).toBe(false);

        const tiered = customerPrice({ mode: 'tiered', tiers: twoTiers }, 2);
        expect(catalogMatches(tiered, tiered)).toBe(true);
        expect(catalogMatches({ ...tiered, billing_details: null }, tiered)).toBe(false);
        const changed = structuredClone(tiered);
        changed.billing_details!.tiers[1].rates.output = 44;
        expect(catalogMatches(changed, tiered)).toBe(false);
    });

    it('lists exactly which fields differ', () => {
        const cached = customerPrice({ mode: 'token', input: 5, output: 40, cache_read: 0.5, cache_write: null }, 1.2);
        // Same input/output, but the catalog never recorded the cache price.
        expect(catalogDiffs({ ...cached, billing_details: null }, cached)).toEqual([
            { tier: null, field: 'cache_read', catalog: null, expected: 0.6 },
        ]);
        const cacheChanged = structuredClone(cached);
        cacheChanged.billing_details!.tiers[0].rates.cache_read = 1.2;
        expect(catalogDiffs(cacheChanged, cached)).toEqual([
            { tier: null, field: 'cache_read', catalog: 1.2, expected: 0.6 },
        ]);
        // A scalar difference is reported once, not again from the uniform tier.
        const inputChanged = structuredClone(cached);
        inputChanged.input_cny_per_1m = 4;
        inputChanged.billing_details!.tiers[0].rates.input = 4;
        expect(catalogDiffs(inputChanged, cached)).toEqual([{ tier: null, field: 'input', catalog: 4, expected: 6 }]);

        const tiered = customerPrice({ mode: 'tiered', tiers: twoTiers }, 2);
        expect(catalogDiffs(tiered, tiered)).toEqual([]);
        expect(catalogDiffs({ ...tiered, billing_details: null }, tiered)).toEqual([
            { tier: null, field: 'tier_count', catalog: null, expected: 2 },
        ]);
        const tierChanged = structuredClone(tiered);
        tierChanged.billing_details!.tiers[1].rates.cache_read = 1;
        expect(catalogDiffs(tierChanged, tiered)).toEqual([
            { tier: 1, field: 'cache_read', catalog: 1, expected: 1.2 },
        ]);
    });
});

describe('video-token matrices', () => {
    const CELLS: Array<[string, string, number]> = [
        ['480p', 'none', 9.34],
        ['480p', 'video', 5.6],
        ['720p', 'none', 9.34],
        ['720p', 'video', 5.6],
        ['1080p', 'none', 10.27],
        ['1080p', 'video', 6.14],
        ['4k', 'none', 10.27],
        ['4k', 'video', 6.14],
    ];
    const expression = CELLS.map(([resolution, input, price], index) => {
        const call = `tier("${resolution}·${input}", u("tokens") * ${price} / 1000000)`;
        return index === CELLS.length - 1
            ? call
            : `u("resolution") == "${resolution}" && u("video_input") == "${input}" ? ${call}`;
    }).join(' : ');
    const video = (overrides: Record<string, unknown> = {}) =>
        options({
            [MODE]: JSON.stringify({ seedance: 'tiered_expr' }),
            [EXPR]: JSON.stringify({ seedance: expression }),
            ...overrides,
        });

    it('reads every cell and the unconditioned fallback', () => {
        const base = readBasePrice(video(), 'seedance');
        if (base?.mode !== 'video_token') throw Error('wrong mode');
        expect(base.cells.map((cell) => cell.price)).toEqual(CELLS.map(([, , price]) => price));
        expect(base.fallback).toEqual({ resolution: '4k', video_input: 'video' });
    });

    it('refuses to turn a video matrix into another billing mode', () => {
        expect(() => planModelWrites(video(), 'seedance', { mode: 'per_call', price: 1 })).toThrow('参考视频');
        expect(() =>
            planModelWrites(video(), 'seedance', {
                mode: 'token',
                input: 1,
                output: 2,
                cache_read: null,
                cache_write: null,
            }),
        ).toThrow('参考视频');
    });

    it('rewrites only the coefficients, and writes nothing when they are unchanged', () => {
        const source = video();
        const cells = CELLS.map(([resolution, video_input, price]) => ({
            resolution: resolution as '480p',
            video_input: video_input as 'none',
            price,
        }));
        expect(planVideoTokenWrites(source, 'seedance', cells)).toEqual([]);
        const writes = planVideoTokenWrites(source, 'seedance', [{ ...cells[0], price: 7.01 }, ...cells.slice(1)]);
        expect(writes.map((write) => write.key)).toEqual([EXPR]);
        const next = (writes[0].value as Record<string, string>).seedance;
        expect(next).toBe(expression.replace('* 9.34 / 1000000', '* 7.01 / 1000000'));
        // Conditions, labels and the other seven prices are untouched.
        expect(next.replace('7.01', '9.34')).toBe(expression);
    });

    it('refuses a matrix that is also priced per call, or is no longer a task formula', () => {
        const cells = CELLS.map(([resolution, video_input, price]) => ({
            resolution: resolution as '480p',
            video_input: video_input as 'none',
            price,
        }));
        expect(() =>
            planVideoTokenWrites(video({ ModelPrice: JSON.stringify({ seedance: 2 }) }), 'seedance', cells),
        ).toThrow('按次价格');
        expect(() => planVideoTokenWrites(options(), 'gpt-5.5', cells)).toThrow('视频 token');
    });

    it('prices every cell by the tier ratio and reports a changed cell as a rule difference', () => {
        const base = readBasePrice(video(), 'seedance')!;
        const expected = customerPrice(base, 1.2);
        expect(expected).toMatchObject({ input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: null });
        if (expected.billing_details?.mode !== 'video_token') throw Error('wrong mode');
        expect(expected.billing_details.cells[0]).toEqual({
            resolution: '480p',
            video_input: 'none',
            price: Number((9.34 * 1.2).toFixed(12)),
        });
        expect(catalogMatches(expected, expected)).toBe(true);
        const changed = structuredClone(expected);
        if (changed.billing_details?.mode !== 'video_token') throw Error('wrong mode');
        changed.billing_details.cells[3].price = 1;
        expect(catalogDiffs(changed, expected)).toEqual([
            { tier: null, field: 'billing_rule', catalog: null, expected: null },
        ]);
    });
});

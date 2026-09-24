import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/newapi/quota-units', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/newapi/quota-units')>()),
    QUOTA_PER_USD: 500_000,
    USD_TO_CNY_RATE: 1,
}));

import {
    GROUP_SETTING_KEY,
    catalogMatches,
    customerPrice,
    modelOptionState,
    planGroupRatioWrites,
    planModelWrites,
    readBasePrice,
    unverifiedWrites,
    type BasePrice,
    type OptionWrite,
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

    it('does not invent a group_ratio_setting entry', () => {
        expect(planGroupRatioWrites(options(), 'vip', 2).map((write) => write.key)).toEqual(['GroupRatio']);
    });

    it('is empty when unchanged and rejects nonsense ratios', () => {
        expect(planGroupRatioWrites(options(), 'default', 1.2)).toEqual([]);
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
});

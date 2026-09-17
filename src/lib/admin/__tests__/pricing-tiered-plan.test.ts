import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/newapi/client', () => ({ getOption: vi.fn(), putOption: vi.fn() }));
vi.mock('@/lib/newapi/quota-units', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    QUOTA_PER_USD: 500_000,
    USD_TO_CNY_RATE: 1,
    quotaToCny: (quota: number) => quota / 500_000,
}));

import {
    assertRecoverableTieredOptions,
    buildTieredPublishPlan,
    EXPRESSION_KEY,
    isTieredInput,
    tieredDetails,
    tieredPriceOptions,
    tieredProbeInput,
} from '../pricing-tiered-plan';
import type { PublishSource, PublishState } from '../pricing-publish-plan';
import type { PricingPublishInput } from '../pricing-publish-types';
import { CHAT_FX, IMAGE_FX } from '@/lib/newapi/pricing-sync';
import { buildUniformPublishPlan } from '../pricing-uniform-plan';
import { parseTieredPricingExpression, uniformTokenPricingExpression } from '../pricing-tiered-expression';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const DATE = new Date(NOW - 60_000).toISOString();
const MODEL = '11111111-1111-4111-8111-111111111111';
const EXPRESSION = 'len < 272000 ? tier("base", p * 5 + c * 30 + cr * 0.5) : tier("tier_2", p * 10 + c * 45 + cr * 1)';
const SCALED =
    'len < 272000 ? tier("base", p * 5.625 + c * 33.75 + cr * 0.5625) : tier("tier_2", p * 11.25 + c * 50.625 + cr * 1.125)';

function fixture() {
    const state: PublishState = {
        models: [
            {
                id: MODEL,
                tenant_id: 'tenant',
                slug: 'gpt-5.5',
                display_name: 'GPT 5.5',
                modality: 'chat',
                enabled: true,
                updated_at: DATE,
                upstream_map: {
                    enterprise: { channel_id: 5, upstream_model: 'gpt-5.5' },
                    partner: { channel_id: 6, upstream_model: 'gpt-5.5' },
                },
            },
        ],
        groups: ['enterprise', 'partner'].map((tier, i) => ({
            id: `group-${i}`,
            tenant_id: 'tenant',
            key: tier,
            display_name: tier,
            newapi_group: tier,
            enabled: true,
            is_default: i === 0,
            tier_level: i,
            newapi_channel_ids: [i + 5],
            updated_at: DATE,
        })),
        prices: ['enterprise', 'partner'].map((tier, i) => ({
            id: `price-${i}`,
            model_id: MODEL,
            tier,
            effective_from: DATE,
            input_cny_per_1m: i ? 1 : 0.8,
            output_cny_per_1m: i ? 6 : 4.8,
            per_image_cny: null,
            cost_cny_per_1m: 0.65,
        })),
    };
    const source: PublishSource = {
        channels: ['enterprise', 'partner'].map((group, i) => ({
            id: i + 5,
            name: group,
            status: 1,
            groups: [group],
            models: ['gpt-5.5'],
        })),
        options: {
            ModelRatio: { 'gpt-5.5': 2.5, untouched: 1 },
            CompletionRatio: { 'gpt-5.5': 6, untouched: 2 },
            CompletionRatioMeta: { 'gpt-5.5': { ratio: 6, locked: false } },
            ModelPrice: {},
            GroupRatio: { enterprise: 0.16, partner: 0.2 },
            GroupGroupRatio: { 'customer-1': { enterprise: 0.18 }, 'customer-2': { enterprise: 0.18 } },
            QuotaPerUnit: '500000',
            ImageResolutionPrice: {},
            'billing_setting.billing_mode': { 'gpt-5.5': 'tiered_expr' },
            'billing_setting.scheduled_discount': {},
            [EXPRESSION_KEY]: { 'gpt-5.5': EXPRESSION, untouched: 'tier("default", p * 1 + c * 2)' },
        },
    };
    const input: PricingPublishInput = {
        model_id: MODEL,
        tier: 'enterprise',
        input_cny_per_1m: 0.8,
        output_cny_per_1m: 4.8,
        cache_read_cny_per_1m: 0.08,
        per_image_cny: null,
        cost_cny_per_1m: null,
    };
    return { state, source, input };
}

describe('tiered expression publication planning', () => {
    it('uses expression USD units, not ordinary ModelRatio units, with production quota conversion', () => {
        expect(CHAT_FX).toBe(2);
        expect(IMAGE_FX).toBe(1);
        const details = tieredDetails(EXPRESSION, 0.16);
        expect(details).toMatchObject({
            mode: 'tiered_token',
            unit: 'cny_per_million_tokens',
            semantics: 'whole_request',
        });
        expect(details.tiers.map((tier) => tier.rates)).toEqual([
            { input: 0.8, output: 4.8, cache_read: 0.08, cache_write: null, cache_write_1h: null },
            { input: 1.6, output: 7.2, cache_read: 0.16, cache_write: null, cache_write_1h: null },
        ]);
    });

    it('recognizes an already configured 0.8/4.8/0.08 as a no-op and retains full metadata', () => {
        const { state, source, input } = fixture();
        const before = structuredClone({ state, source, input });
        const plan = buildTieredPublishPlan(state, source, [input], NOW);
        expect(plan.version).toBe(3);
        expect(plan.unchanged).toBe(true);
        expect(plan.target).toEqual({ [EXPRESSION_KEY]: { 'gpt-5.5': EXPRESSION } });
        expect(plan.rows).toHaveLength(2);
        expect(plan.rows[0].after_details?.tiers).toHaveLength(2);
        expect(plan.rows[0].after_details?.tiers[1]).toMatchObject({ min_input_tokens: 272000, min_inclusive: true });
        expect(plan.rows[0].after).toEqual({ input_cny_per_1m: 0.8, output_cny_per_1m: 4.8, per_image_cny: null });
        expect({ state, source, input }).toEqual(before);
    });

    it('scales every tier and cache by 1.125, exposes shared-group impact, and uses dedicated ratios as replacements', () => {
        const { state, source, input } = fixture();
        const plan = buildTieredPublishPlan(
            state,
            source,
            [{ ...input, input_cny_per_1m: 0.9, output_cny_per_1m: 5.4, cache_read_cny_per_1m: 0.09 }],
            NOW,
        );
        expect(plan.unchanged).toBe(false);
        expect(plan.target).toEqual({ [EXPRESSION_KEY]: { 'gpt-5.5': SCALED } });
        expect(plan.baseline.GroupRatio).toEqual({ enterprise: 0.16, partner: 0.2 });
        expect(plan.rows[0].after_details?.tiers.map((tier) => tier.rates)).toEqual([
            { input: 0.9, output: 5.4, cache_read: 0.09, cache_write: null, cache_write_1h: null },
            { input: 1.8, output: 8.1, cache_read: 0.18, cache_write: null, cache_write_1h: null },
        ]);
        expect(plan.rows[1].after_details?.tiers[0].rates).toMatchObject({
            input: 1.125,
            output: 6.75,
            cache_read: 0.1125,
        });
        expect(plan.customer_overrides).toHaveLength(1);
        expect(plan.customer_overrides[0]).toMatchObject({
            group: 'enterprise',
            ratio: 0.18,
            public_ratio: 0.16,
            count: 2,
        });
        expect(plan.customer_overrides[0].before.tiers[0].rates).toMatchObject({
            input: 0.9,
            output: 5.4,
            cache_read: 0.09,
        });
        expect(plan.customer_overrides[0].after.tiers[0].rates).toMatchObject({
            input: 1.0125,
            output: 6.075,
            cache_read: 0.10125,
        });
    });

    it('keeps existing catalog cost when the cost workflow has no equivalent one-column cost', () => {
        const { state, source, input } = fixture();
        expect(buildTieredPublishPlan(state, source, [input], NOW).rows[0].cost_cny_per_1m).toBe(0.65);
    });

    it('probes the existing absolute first-tier price without guessing a retail multiplier', () => {
        const { state, source, input } = fixture();
        expect(isTieredInput(state, source, input)).toBe(true);
        expect(tieredProbeInput(state, source, MODEL, 'enterprise')).toEqual(input);
    });

    it.each([
        ['missing cache', { cache_read_cny_per_1m: undefined }, 'pricing_tiered_cache'],
        ['wrong cache', { cache_read_cny_per_1m: 0.07 }, 'pricing_tiered_cache'],
        ['wrong output', { output_cny_per_1m: 4.7 }, 'pricing_tiered_proportions'],
        ['absent input', { input_cny_per_1m: null }, 'pricing_basis_change'],
        ['free input', { input_cny_per_1m: 0 }, 'pricing_basis_change'],
        ['image price', { per_image_cny: 1 }, 'pricing_basis_change'],
    ] as const)('rejects %s', (_label, change, code) => {
        const { state, source, input } = fixture();
        expect(() => buildTieredPublishPlan(state, source, [{ ...input, ...change }], NOW)).toThrow(
            expect.objectContaining({ code }),
        );
    });

    it.each([
        ['cache writes', EXPRESSION.replaceAll('cr * 0.5', 'cr * 0.5 + cc * 1'), 'pricing_cache_write_unsupported'],
        [
            'one-hour writes',
            EXPRESSION.replaceAll('cr * 0.5', 'cr * 0.5 + cc1h * 1'),
            'pricing_cache_write_unsupported',
        ],
        ['request condition', EXPRESSION + ' ||| header("x", "y")', 'pricing_tiered_unsupported'],
        ['computed coefficients', EXPRESSION.replace('p * 5', 'p * (5 + 1)'), 'pricing_tiered_unsupported'],
    ])('rejects %s instead of silently dropping rules', (_label, expr, code) => {
        const { state, source, input } = fixture();
        (source.options[EXPRESSION_KEY] as Record<string, string>)['gpt-5.5'] = expr;
        expect(() => buildTieredPublishPlan(state, source, [input], NOW)).toThrow(expect.objectContaining({ code }));
    });

    it('rejects adding cache pricing to a formula without an independent cache term', () => {
        const { state, source, input } = fixture();
        (source.options[EXPRESSION_KEY] as Record<string, string>)['gpt-5.5'] = EXPRESSION.replace(
            / \+ cr \* (0\.5|1)/g,
            '',
        );
        expect(() => buildTieredPublishPlan(state, source, [input], NOW)).toThrow(
            expect.objectContaining({ code: 'pricing_tiered_cache' }),
        );
    });

    it('rejects multi-rule batches and additional active billing rules', () => {
        const { state, source, input } = fixture();
        expect(() => buildTieredPublishPlan(state, source, [input, { ...input, tier: 'partner' }], NOW)).toThrow(
            expect.objectContaining({ code: 'pricing_tiered_batch' }),
        );
        for (const key of ['ImageResolutionPrice', 'billing_setting.scheduled_discount', 'ModelPrice']) {
            const modified = structuredClone(source);
            (modified.options[key] as Record<string, unknown>)['gpt-5.5'] =
                key === 'ModelPrice' ? 0 : { enabled: true };
            expect(() => buildTieredPublishPlan(state, modified, [input], NOW)).toThrow();
        }
    });

    it('keeps topology and quota compatibility as mandatory gates', () => {
        const { state, source, input } = fixture();
        const unavailable = structuredClone(source);
        unavailable.channels[0].status = 2;
        expect(() => buildTieredPublishPlan(state, unavailable, [input], NOW)).toThrow(
            expect.objectContaining({ code: 'pricing_channel_unavailable' }),
        );
        const wrongQuota = structuredClone(source);
        wrongQuota.options.QuotaPerUnit = '1000000';
        expect(() => buildTieredPublishPlan(state, wrongQuota, [input], NOW)).toThrow(
            expect.objectContaining({ code: 'pricing_units_mismatch' }),
        );
    });

    it.each([NaN, Infinity, -1, Number.MAX_VALUE])('rejects invalid or overflowing detail multipliers: %s', (ratio) => {
        expect(() => tieredDetails(EXPRESSION, ratio)).toThrow();
    });

    it('does not round a paid cache or token category to zero in dynamic metadata', () => {
        expect(() => tieredDetails(EXPRESSION, 0.0000000000001)).toThrow();
        const free = tieredDetails('tier("base", p * 5 + c * 0 + cr * 0)', 0.16);
        expect(free.tiers[0].rates).toMatchObject({ input: 0.8, output: 0, cache_read: 0 });
    });

    it.each([100_000_000, 0.0000000000001])('rejects unrepresentable prices in any shared group: %s', (ratio) => {
        const { state, source, input } = fixture();
        (source.options.GroupRatio as Record<string, number>).partner = ratio;
        expect(() => buildTieredPublishPlan(state, source, [input], NOW)).toThrow();
    });

    it('does not silently turn a shared group price into zero in the legacy four-place catalog', () => {
        const { state, source, input } = fixture();
        (source.options.GroupRatio as Record<string, number>).partner = 0.000001;
        expect(() => buildTieredPublishPlan(state, source, [input], NOW)).toThrow();
    });

    it.each(['output', 'cache_read'] as const)(
        'does not accept an explicit free %s target for a nonzero expression price',
        (field) => {
            const { state, source, input } = fixture();
            (source.options[EXPRESSION_KEY] as Record<string, string>)['gpt-5.5'] =
                field === 'output'
                    ? EXPRESSION.replace('c * 30', 'c * 0.0000000005')
                    : EXPRESSION.replace('cr * 0.5', 'cr * 0.0000000005');
            const changed = { ...input, [field === 'output' ? 'output_cny_per_1m' : 'cache_read_cny_per_1m']: 0 };
            expect(() => buildTieredPublishPlan(state, source, [changed], NOW)).toThrow();
        },
    );

    it('allows only the exact old/new target expression during recovery and protects every other dictionary entry', () => {
        const { state, source, input } = fixture();
        const plan = buildTieredPublishPlan(
            state,
            source,
            [{ ...input, input_cny_per_1m: 0.9, output_cny_per_1m: 5.4, cache_read_cny_per_1m: 0.09 }],
            NOW,
        );
        const baseline = tieredPriceOptions(source.options);
        expect(() => assertRecoverableTieredOptions(baseline, plan)).not.toThrow();
        const applied = structuredClone(baseline);
        applied[EXPRESSION_KEY]['gpt-5.5'] = SCALED;
        expect(() => assertRecoverableTieredOptions(applied, plan)).not.toThrow();
        for (const key of Object.keys(baseline)) {
            const changed = structuredClone(baseline);
            changed[key as keyof typeof changed].untouched = 'different';
            expect(() => assertRecoverableTieredOptions(changed, plan)).toThrow(
                expect.objectContaining({ code: 'pricing_conflict' }),
            );
        }
        applied[EXPRESSION_KEY]['gpt-5.5'] = SCALED.replace('272000', '128000');
        expect(() => assertRecoverableTieredOptions(applied, plan)).toThrow(
            expect.objectContaining({ code: 'pricing_conflict' }),
        );
    });
});

describe('v4 uniform customer token pricing', () => {
    it('replaces the complete two-tier tariff with one fixed input/output/cache price at every length', () => {
        const { state, source, input } = fixture();
        const before = structuredClone({ state, source, input });
        const plan = buildUniformPublishPlan(state, source, [input], NOW);
        expect(plan).toMatchObject({ version: 4, strategy: 'uniform_token', unchanged: false });
        expect(plan.target).toEqual({
            [EXPRESSION_KEY]: { 'gpt-5.5': 'tier("uniform", p * 5 + c * 30 + cr * 0.5)' },
        });
        expect(plan.rows[0].before_details?.tiers).toHaveLength(2);
        expect(plan.rows[0].after_details?.tiers).toEqual([
            {
                name: 'uniform',
                min_input_tokens: null,
                max_input_tokens: null,
                min_inclusive: false,
                max_inclusive: false,
                rates: { input: 0.8, output: 4.8, cache_read: 0.08, cache_write: null, cache_write_1h: null },
            },
        ]);
        expect(plan.warnings.join(' ')).not.toContain('保留原有边界');
        expect({ state, source, input }).toEqual(before);
    });

    it('accepts independently specified input, output and cache prices, without inheriting old proportions', () => {
        const { state, source, input } = fixture();
        const plan = buildUniformPublishPlan(
            state,
            source,
            [
                {
                    ...input,
                    input_cny_per_1m: 1.6,
                    output_cny_per_1m: 7.2,
                    cache_read_cny_per_1m: 0.12,
                },
            ],
            NOW,
        );
        expect(plan.target[EXPRESSION_KEY]['gpt-5.5']).toBe('tier("uniform", p * 10 + c * 45 + cr * 0.75)');
        expect(plan.rows[0].after_details?.tiers[0].rates).toMatchObject({ input: 1.6, output: 7.2, cache_read: 0.12 });
        expect(plan.rows[1].after_details?.tiers[0].rates).toMatchObject({ input: 2, output: 9, cache_read: 0.15 });
        expect(plan.customer_overrides[0].after.tiers[0].rates).toMatchObject({
            input: 1.8,
            output: 8.1,
            cache_read: 0.135,
        });
        expect(plan.baseline.GroupRatio).toEqual({ enterprise: 0.16, partner: 0.2 });
    });

    it('does not apply the retail multiplier again on a second preview after publication', () => {
        const { state, source, input } = fixture();
        const plan = buildUniformPublishPlan(state, source, [input], NOW);
        (source.options[EXPRESSION_KEY] as Record<string, string>)['gpt-5.5'] = plan.target[EXPRESSION_KEY]['gpt-5.5'];
        const repeated = buildUniformPublishPlan(state, source, [input], NOW);
        expect(repeated.unchanged).toBe(true);
        expect(repeated.target).toEqual(plan.target);
        expect(repeated.rows[0].after_details).toEqual(plan.rows[0].after_details);
    });

    it('requires an explicit cached read target rather than silently dropping existing cached-token billing', () => {
        const { state, source, input } = fixture();
        delete input.cache_read_cny_per_1m;
        expect(() => buildUniformPublishPlan(state, source, [input], NOW)).toThrow(
            expect.objectContaining({ code: 'pricing_uniform_cache' }),
        );
    });

    it('can add explicitly supplied cached read pricing to a linear expression that lacked it', () => {
        const { state, source, input } = fixture();
        (source.options[EXPRESSION_KEY] as Record<string, string>)['gpt-5.5'] = 'tier("base", p * 5 + c * 30)';
        const plan = buildUniformPublishPlan(state, source, [input], NOW);
        expect(plan.rows[0].before_details?.tiers[0].rates.cache_read).toBeNull();
        expect(plan.rows[0].after_details?.tiers[0].rates.cache_read).toBe(0.08);
    });

    it('keeps an absent cache category absent and allows explicitly free output or cached read', () => {
        const { state, source, input } = fixture();
        const free = buildUniformPublishPlan(
            state,
            source,
            [{ ...input, output_cny_per_1m: 0, cache_read_cny_per_1m: 0 }],
            NOW,
        );
        expect(free.target[EXPRESSION_KEY]['gpt-5.5']).toBe('tier("uniform", p * 5 + c * 0 + cr * 0)');
        (source.options[EXPRESSION_KEY] as Record<string, string>)['gpt-5.5'] = 'tier("base", p * 5 + c * 30)';
        delete input.cache_read_cny_per_1m;
        expect(
            buildUniformPublishPlan(state, source, [input], NOW).rows[0].after_details?.tiers[0].rates.cache_read,
        ).toBeNull();
    });

    it('uses exact decimal division for each price and applies group/currency conversion once', () => {
        const expression = uniformTokenPricingExpression({ input: 0.8, output: 4.8, cache_read: 0.08125 }, 0.16, 1);
        expect(expression).toBe('tier("uniform", p * 5 + c * 30 + cr * 0.5078125)');
        const fx = uniformTokenPricingExpression({ input: 0.8, output: 4.8, cache_read: 0.08 }, 0.2, 2);
        expect(parseTieredPricingExpression(fx).tiers[0].rates).toMatchObject({
            input: 2,
            output: 12,
            cache_read: 0.2,
        });
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MIN_VALUE])(
        'rejects invalid or unrepresentable cached price %s',
        (price) => {
            const { state, source, input } = fixture();
            expect(() =>
                buildUniformPublishPlan(state, source, [{ ...input, cache_read_cny_per_1m: price }], NOW),
            ).toThrow();
        },
    );

    it('does not change the target of a legacy V3 plan while offering V4 separately', () => {
        const { state, source, input } = fixture();
        const legacy = buildTieredPublishPlan(state, source, [input], NOW);
        const uniform = buildUniformPublishPlan(state, source, [input], NOW);
        expect(legacy.target[EXPRESSION_KEY]['gpt-5.5']).toBe(EXPRESSION);
        expect(legacy.version).toBe(3);
        expect(uniform.version).toBe(4);
        expect(uniform.target[EXPRESSION_KEY]['gpt-5.5']).not.toContain('len');
        expect(() => assertRecoverableTieredOptions(tieredPriceOptions(source.options), uniform)).not.toThrow();
    });

    it('retains every existing source, quota, topology and advanced-rule safety gate', () => {
        const { state, source, input } = fixture();
        for (const key of ['ImageResolutionPrice', 'billing_setting.scheduled_discount', 'ModelPrice']) {
            const modified = structuredClone(source);
            (modified.options[key] as Record<string, unknown>)['gpt-5.5'] =
                key === 'ModelPrice' ? 0 : { enabled: true };
            expect(() => buildUniformPublishPlan(state, modified, [input], NOW)).toThrow();
        }
        expect(() => buildUniformPublishPlan(state, source, [input, input], NOW)).toThrow();
        source.channels[0].status = 2;
        expect(() => buildUniformPublishPlan(state, source, [input], NOW)).toThrow();
    });
});

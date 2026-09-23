import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/newapi/client', () => ({ getOption: vi.fn(), putOption: vi.fn() }));
vi.mock('@/lib/newapi/quota-units', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    QUOTA_PER_USD: 500_000,
    USD_TO_CNY_RATE: 1,
    quotaToCny: (quota: number) => quota / 500_000,
}));

import { buildGlobalModelPlan, globalModelOfficialQuote, globalModelPriceInfo } from '../global-model-pricing';
import type { GlobalModelBaseInput } from '../global-model-pricing-types';
import type { PublishSource, PublishState } from '../pricing-publish-plan';
import {
    assertGroupRatioRuntime,
    assertRecoverableGroupRatioOptions,
    buildGroupRatioPublishPlan,
} from '../pricing-group-ratio-plan';
import { EXPRESSION_KEY, tieredPriceOptions } from '../pricing-tiered-plan';
import type { NewApiRuntimePricing } from '@/lib/newapi/client';
import type { OfficialPriceCatalog } from '../litellm-official-prices';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const DATE = new Date(NOW - 60_000).toISOString();
const MODEL = '11111111-1111-4111-8111-111111111111';
const TIERED = 'len < 272000 ? tier("base", p * 5 + c * 30 + cr * 0.5) : tier("long", p * 10 + c * 45 + cr * 1)';

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
            cost_cny_per_1m: i ? 0.75 : 0.65,
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
            ModelRatio: { 'gpt-5.5': 2.5 },
            CompletionRatio: { 'gpt-5.5': 6 },
            CompletionRatioMeta: { 'gpt-5.5': { ratio: 6, locked: false } },
            ModelPrice: {},
            GroupRatio: { enterprise: 0.16, partner: 0.2 },
            GroupGroupRatio: {},
            QuotaPerUnit: '500000',
            ImageResolutionPrice: {},
            'billing_setting.billing_mode': { 'gpt-5.5': 'ratio' },
            'billing_setting.scheduled_discount': {},
            [EXPRESSION_KEY]: {},
        },
    };
    const input: GlobalModelBaseInput = {
        model_id: MODEL,
        base_input_cny_per_1m: 6,
        base_output_cny_per_1m: 36,
        base_per_image_cny: null,
    };
    return { state, source, input };
}

describe('model-global official base pricing', () => {
    function catalog(
        models: OfficialPriceCatalog['models'] = [
            {
                model: 'gpt-5.5',
                provider: 'openai',
                inputUsdPer1m: 1.25,
                outputUsdPer1m: 10,
                cacheReadUsdPer1m: 0.125,
                cacheWrite5mUsdPer1m: 1.5,
                cacheWrite1hUsdPer1m: 3,
            },
        ],
    ): OfficialPriceCatalog {
        return {
            source: 'litellm-cdn',
            sourceLabel: 'LiteLLM CDN',
            fetchedAt: '2026-09-24T00:00:00.000Z',
            models,
        };
    }

    it('matches the mapped upstream name exactly and converts the quote with the explicit real FX rate', () => {
        const { state, source } = fixture();

        const input = globalModelOfficialQuote(state, source, MODEL, catalog(), 7.2);

        expect(input.official_quote).toMatchObject({
            upstream_model: 'gpt-5.5',
            provider: 'openai',
            source: 'litellm-cdn',
            fetched_at: '2026-09-24T00:00:00.000Z',
            input_usd_per_1m: 1.25,
            output_usd_per_1m: 10,
            input_cny_per_1m: 9,
            output_cny_per_1m: 72,
            cache_read_cny_per_1m: 0.9,
            cache_write_5m_cny_per_1m: 10.8,
            cache_write_1h_cny_per_1m: 21.6,
            usd_to_cny_rate: 7.2,
        });
        expect(input.base_input_cny_per_1m).toBeNull();
    });

    it('rejects missing, duplicate, and non-exact catalog names', () => {
        const { state, source } = fixture();

        expect(() => globalModelOfficialQuote(state, source, MODEL, catalog([]), 7.2)).toThrow(/没有精确匹配/);
        expect(() =>
            globalModelOfficialQuote(
                state,
                source,
                MODEL,
                catalog([...catalog().models, { ...catalog().models[0], provider: 'another-provider' }]),
                7.2,
            ),
        ).toThrow(/重复报价/);
        expect(() =>
            globalModelOfficialQuote(
                state,
                source,
                MODEL,
                catalog([{ ...catalog().models[0], model: 'provider/gpt-5.5' }]),
                7.2,
            ),
        ).toThrow(/没有精确匹配/);
    });

    it('fails closed when the real FX rate is absent or invalid', () => {
        const { state, source } = fixture();
        const previous = process.env.REAL_USD_TO_CNY_RATE;
        try {
            delete process.env.REAL_USD_TO_CNY_RATE;
            expect(() => globalModelOfficialQuote(state, source, MODEL, catalog())).toThrow(/汇率未配置或无效/);
            process.env.REAL_USD_TO_CNY_RATE = 'not-a-rate';
            expect(() => globalModelOfficialQuote(state, source, MODEL, catalog())).toThrow(/汇率未配置或无效/);
        } finally {
            if (previous === undefined) delete process.env.REAL_USD_TO_CNY_RATE;
            else process.env.REAL_USD_TO_CNY_RATE = previous;
        }
    });

    it('applies each unchanged GroupRatio to the converted reference price', () => {
        const { state, source } = fixture();
        const quoteInput = globalModelOfficialQuote(state, source, MODEL, catalog(), 7.2);
        const plan = buildGlobalModelPlan(state, source, quoteInput, NOW);

        expect(source.options.GroupRatio).toEqual({ enterprise: 0.16, partner: 0.2 });
        expect(plan.rows.map((row) => [row.tier, row.after])).toEqual([
            ['enterprise', { input_cny_per_1m: 1.44, output_cny_per_1m: 11.52, per_image_cny: null }],
            ['partner', { input_cny_per_1m: 1.8, output_cny_per_1m: 14.4, per_image_cny: null }],
        ]);
        expect(plan.global_quote_snapshot).toEqual(quoteInput.official_quote);
    });

    it('rejects LiteLLM token quotes for image and request-priced models', () => {
        const { state, source } = fixture();
        state.models[0].modality = 'image';
        expect(() => globalModelOfficialQuote(state, source, MODEL, catalog(), 7.2)).toThrow(/按次\/图片模型/);

        state.models[0].modality = 'chat';
        source.options.ModelPrice = { 'gpt-5.5': 1 };
        expect(() => globalModelOfficialQuote(state, source, MODEL, catalog(), 7.2)).toThrow(/按次\/图片模型/);
    });

    it('writes one shared token target and derives both catalog prices from their unchanged GroupRatio', () => {
        const { state, source, input } = fixture();
        const original = structuredClone(source.options);

        const plan = buildGlobalModelPlan(state, source, input, NOW);

        expect(plan).toMatchObject({ version: 2, global_model: true, global_input: input });
        expect(plan.target).toEqual({ ModelRatio: { 'gpt-5.5': 3 }, CompletionRatio: { 'gpt-5.5': 6 } });
        expect(plan.rows.map((row) => [row.tier, row.after, row.cost_cny_per_1m])).toEqual([
            ['enterprise', { input_cny_per_1m: 0.96, output_cny_per_1m: 5.76, per_image_cny: null }, 0.65],
            ['partner', { input_cny_per_1m: 1.2, output_cny_per_1m: 7.2, per_image_cny: null }, 0.75],
        ]);
        expect(source.options).toEqual(original);
        expect(globalModelPriceInfo(state, source, MODEL)).toMatchObject({
            base_input_cny_per_1m: 5,
            base_output_cny_per_1m: 30,
        });
    });

    it('does not derive different shared targets from tier-rounding at near-boundary base prices', () => {
        const { state, source, input } = fixture();
        input.base_input_cny_per_1m = 5.0001;
        input.base_output_cny_per_1m = 30.0006;

        const plan = buildGlobalModelPlan(state, source, input, NOW);

        expect(plan.target).toEqual({ ModelRatio: { 'gpt-5.5': 2.50005 }, CompletionRatio: { 'gpt-5.5': 6 } });
        expect(plan.rows.map((row) => [row.tier, row.after.input_cny_per_1m])).toEqual([
            ['enterprise', 0.8],
            ['partner', 1],
        ]);
    });

    it('writes one shared request price and preserves both catalog costs', () => {
        const { state, source, input } = fixture();
        state.models[0].modality = 'image';
        state.prices[0] = { ...state.prices[0], input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: 0.16 };
        state.prices[1] = { ...state.prices[1], input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: 0.2 };
        source.options.ModelPrice = { 'gpt-5.5': 1 };
        input.base_input_cny_per_1m = null;
        input.base_output_cny_per_1m = null;
        input.base_per_image_cny = 2;

        const plan = buildGlobalModelPlan(state, source, input, NOW);

        expect(plan.target).toEqual({ ModelPrice: { 'gpt-5.5': 2 } });
        expect(plan.rows.map((row) => [row.tier, row.after.per_image_cny, row.cost_cny_per_1m])).toEqual([
            ['enterprise', 0.32, 0.65],
            ['partner', 0.4, 0.75],
        ]);
    });

    it('makes a tiered model uniform and warns that length tiers are removed', () => {
        const { state, source } = fixture();
        source.options['billing_setting.billing_mode'] = { 'gpt-5.5': 'tiered_expr' };
        source.options[EXPRESSION_KEY] = { 'gpt-5.5': TIERED };
        const input: GlobalModelBaseInput = {
            model_id: MODEL,
            base_input_cny_per_1m: 6,
            base_output_cny_per_1m: 36,
            base_per_image_cny: null,
            base_cache_read_cny_per_1m: 0.6,
        };

        const plan = buildGlobalModelPlan(state, source, input, NOW);

        expect(plan).toMatchObject({ version: 5, global_model: true, global_input: input });
        if (plan.version !== 5) throw new Error('Expected uniform expression plan');
        expect(plan.target[EXPRESSION_KEY]?.['gpt-5.5']).toBe('tier("uniform", p * 6 + c * 36 + cr * 0.6)');
        expect(
            plan.rows.map((row) => [row.tier, row.after_details?.tiers.length, row.after, row.cost_cny_per_1m]),
        ).toEqual([
            ['enterprise', 1, { input_cny_per_1m: 0.96, output_cny_per_1m: 5.76, per_image_cny: null }, 0.65],
            ['partner', 1, { input_cny_per_1m: 1.2, output_cny_per_1m: 7.2, per_image_cny: null }, 0.75],
        ]);
        expect(plan.warnings.some((warning) => warning.includes('阶梯') && warning.includes('移除'))).toBe(true);
        expect(source.options[EXPRESSION_KEY]).toEqual({ 'gpt-5.5': TIERED });
    });
});

describe('group multiplier publication and recovery', () => {
    function ratioFixture() {
        const { state, source } = fixture();
        const runtime: NewApiRuntimePricing = {
            group_ratio: { enterprise: 0.16, partner: 0.2 },
            models: [
                {
                    model_name: 'gpt-5.5',
                    quota_type: 0,
                    model_ratio: 2.5,
                    model_price: 0,
                    completion_ratio: 6,
                    enable_groups: ['enterprise', 'partner'],
                    billing_mode: 'ratio',
                    cache_ratio: 0.1,
                },
            ],
        };
        const units = { chat_fx: 2, image_fx: 1, quota_per_usd: 500_000 };
        return { state, source, runtime, units };
    }

    it('changes only the selected GroupRatio and keeps model bases, other groups, and costs', () => {
        const { state, source, runtime, units } = ratioFixture();
        const plan = buildGroupRatioPublishPlan(state, source, 'group-0', 0.18, NOW, runtime, units);

        expect(plan).toMatchObject({ version: 7, strategy: 'group_ratio' });
        expect(plan.target).toEqual({ GroupRatio: { enterprise: 0.18 } });
        expect(plan.rows).toHaveLength(1);
        expect(plan.rows[0]).toMatchObject({
            tier: 'enterprise',
            before: { input_cny_per_1m: 0.8, output_cny_per_1m: 4.8 },
            after: { input_cny_per_1m: 0.9, output_cny_per_1m: 5.4 },
            cost_cny_per_1m: 0.65,
        });
        expect(plan.rows[0].after_details?.tiers[0].rates.cache_read).toBe(0.09);
        expect(plan.baseline.ModelRatio).toEqual({ 'gpt-5.5': 2.5 });
        expect(plan.baseline.GroupRatio.partner).toBe(0.2);
    });

    it('recovers old or target group state but rejects third values and unrelated model edits', () => {
        const { state, source, runtime, units } = ratioFixture();
        const plan = buildGroupRatioPublishPlan(state, source, 'group-0', 0.18, NOW, runtime, units);
        const persisted = structuredClone(tieredPriceOptions(source.options));
        expect(() => assertRecoverableGroupRatioOptions(persisted, plan)).not.toThrow();
        expect(() => assertGroupRatioRuntime(runtime, plan, false)).not.toThrow();

        persisted.GroupRatio.enterprise = 0.18;
        expect(() => assertRecoverableGroupRatioOptions(persisted, plan)).not.toThrow();
        const nextRuntime = structuredClone(runtime);
        nextRuntime.group_ratio.enterprise = 0.18;
        expect(() => assertGroupRatioRuntime(nextRuntime, plan, true)).not.toThrow();

        persisted.GroupRatio.partner = 0.21;
        expect(() => assertRecoverableGroupRatioOptions(persisted, plan)).toThrow();
        persisted.GroupRatio.partner = 0.2;
        persisted.ModelRatio['gpt-5.5'] = 3;
        expect(() => assertRecoverableGroupRatioOptions(persisted, plan)).toThrow();
        nextRuntime.models[0].model_ratio = 3;
        expect(() => assertGroupRatioRuntime(nextRuntime, plan, true)).toThrow();
    });
});

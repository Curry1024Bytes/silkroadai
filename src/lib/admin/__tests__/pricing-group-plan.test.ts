import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/newapi/client', () => ({ getOption: vi.fn(), putOption: vi.fn() }));
vi.mock('@/lib/newapi/quota-units', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    QUOTA_PER_USD: 500_000,
    USD_TO_CNY_RATE: 1,
    quotaToCny: (quota: number) => quota / 500_000,
}));
import { buildGroupPublishPlan, assertGroupRuntime, assertRecoverableGroupOptions } from '../pricing-group-plan';
import { EXPRESSION_KEY, tieredPriceOptions } from '../pricing-tiered-plan';
import type { PublishSource, PublishState } from '../pricing-publish-plan';
import type { PricingPublishInput } from '../pricing-publish-types';
import type { CostBatchContext } from '../pricing-cost-publication-guard';
import type { NewApiRuntimePricing } from '@/lib/newapi/client';
const NOW = Date.parse('2026-09-16T12:00:00Z');
const DATE = new Date(NOW - 60_000).toISOString();
const MODEL = '11111111-1111-4111-8111-111111111111';
const EXPRESSION = 'len < 272000 ? tier("base", p * 5 + c * 30 + cr * 0.5) : tier("tier_2", p * 10 + c * 45 + cr * 1)';

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

const UNIFORM = 'tier("uniform", p * 5 + c * 30 + cr * 0.5)';
function groupFixture() {
    const f = fixture();
    (f.source.options[EXPRESSION_KEY] as Record<string, string>)['gpt-5.5'] = UNIFORM;
    const context: CostBatchContext = {
        selections: [{ rule_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 1 }],
        fingerprint: 'cost',
        group_scope: { tier: 'enterprise', newapi_group: 'enterprise', retail_ratio: 0.18 },
    };
    f.input = { ...f.input, input_cny_per_1m: 0.9, output_cny_per_1m: 5.4, cache_read_cny_per_1m: 0.09 };
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
                billing_mode: 'tiered_expr',
                billing_expr: UNIFORM,
                cache_ratio: 0.1,
            },
        ],
    };
    return { ...f, context, runtime };
}
function build(f: ReturnType<typeof groupFixture>) {
    return buildGroupPublishPlan(f.state, f.source, [f.input], NOW, f.context, f.runtime);
}

describe('group-scoped pricing plans', () => {
    it('updates only selected GroupRatio while keeping shared base and dedicated rates unchanged', () => {
        const f = groupFixture(),
            plan = build(f);
        expect(plan.version).toBe(6);
        expect(plan.target).toEqual({ [EXPRESSION_KEY]: { 'gpt-5.5': UNIFORM }, GroupRatio: { enterprise: 0.18 } });
        expect(plan.rows).toHaveLength(1);
        expect(plan.rows[0]).toMatchObject({
            tier: 'enterprise',
            after: { input_cny_per_1m: 0.9, output_cny_per_1m: 5.4 },
            before_details: { tiers: [{ rates: { input: 0.8 } }] },
        });
        expect(plan.customer_overrides).toHaveLength(1);
        expect(plan.customer_overrides[0]).toMatchObject({
            model_name: 'GPT 5.5',
            count: 2,
            ratio: 0.18,
            public_ratio: 0.18,
        });
        expect(plan.customer_overrides[0].after).toEqual(plan.customer_overrides[0].before);
        expect(f.source.options.GroupRatio).toEqual({ enterprise: 0.16, partner: 0.2 });
    });
    it('allows several distinct expression models in one durable plan', () => {
        const f = groupFixture();
        f.state.models.push({
            ...f.state.models[0],
            id: '22222222-2222-4222-8222-222222222222',
            slug: 'sol',
            display_name: 'Sol',
            upstream_map: { enterprise: { channel_id: 5, upstream_model: 'sol' } },
        });
        f.source.channels[0].models.push('sol');
        (f.source.options[EXPRESSION_KEY] as Record<string, string>).sol =
            'tier("uniform", p * 4 + c * 20 + cr * 0.4 + cc * 5)';
        (f.source.options['billing_setting.billing_mode'] as Record<string, string>).sol = 'tiered_expr';
        (f.source.options.ModelRatio as Record<string, number>).sol = 2;
        (f.source.options.CompletionRatio as Record<string, number>).sol = 5;
        f.runtime.models.push({
            ...f.runtime.models[0],
            model_name: 'sol',
            billing_expr: (f.source.options[EXPRESSION_KEY] as Record<string, string>).sol,
            enable_groups: ['enterprise'],
        });
        const plan = buildGroupPublishPlan(
            f.state,
            f.source,
            [
                f.input,
                {
                    ...f.input,
                    model_id: f.state.models[1].id,
                    input_cny_per_1m: 0.72,
                    output_cny_per_1m: 3.6,
                    cache_read_cny_per_1m: 0.072,
                    cache_write_cny_per_1m: 0.9,
                },
            ],
            NOW,
            f.context,
            f.runtime,
        );
        expect(plan.rows).toHaveLength(2);
        expect(Object.keys(plan.target[EXPRESSION_KEY]!)).toEqual(['gpt-5.5', 'sol']);
        expect(plan.customer_overrides.map((x) => x.model_name)).toEqual(['GPT 5.5', 'Sol']);
    });
    it('rejects shared-model repricing or flattening that changes another group', () => {
        const f = groupFixture();
        f.input.input_cny_per_1m = 1.8;
        f.input.output_cny_per_1m = 10.8;
        f.input.cache_read_cny_per_1m = 0.18;
        expect(() => build(f)).toThrow('其他分组');
        f.input = groupFixture().input;
        (f.source.options[EXPRESSION_KEY] as Record<string, string>)['gpt-5.5'] = EXPRESSION;
        f.runtime.models[0].billing_expr = EXPRESSION;
        expect(() => build(f)).toThrow('其他分组');
    });
    it('can flatten an exclusively owned model without copying upstream tiers', () => {
        const f = groupFixture();
        f.source.channels = f.source.channels.slice(0, 1);
        f.state.models[0].upstream_map = { enterprise: { channel_id: 5, upstream_model: 'gpt-5.5' } };
        (f.source.options[EXPRESSION_KEY] as Record<string, string>)['gpt-5.5'] = EXPRESSION;
        f.runtime.models[0].billing_expr = EXPRESSION;
        f.runtime.models[0].enable_groups = ['enterprise'];
        const plan = build(f);
        expect(plan.rows[0].after_details?.tiers).toHaveLength(1);
        expect(plan.target[EXPRESSION_KEY]!['gpt-5.5']).toBe(UNIFORM);
    });
    it.each(['new model', 'unregistered channel', 'duplicate model', 'wrong group', 'disabled model', 'cross tenant'])(
        'fails closed on %s',
        (scenario) => {
            const f = groupFixture();
            if (scenario === 'new model') f.source.channels[0].models.push('unselected');
            if (scenario === 'unregistered channel') f.source.channels.push({ ...f.source.channels[0], id: 99 });
            if (scenario === 'duplicate model') f.state.models.push({ ...f.state.models[0], id: 'duplicate' });
            if (scenario === 'wrong group') f.context.group_scope!.newapi_group = 'missing';
            if (scenario === 'disabled model') f.state.models[0].enabled = false;
            if (scenario === 'cross tenant') f.state.models[0].tenant_id = 'other';
            expect(() => build(f)).toThrow();
        },
    );
    it('accepts only owned old/target intermediate states and rejects unrelated/third values', () => {
        const plan = build(groupFixture());
        const partial = structuredClone(plan.baseline);
        partial.GroupRatio.enterprise = 0.18;
        expect(() => assertRecoverableGroupOptions(partial, plan)).not.toThrow();
        partial.GroupRatio.partner = 0.3;
        expect(() => assertRecoverableGroupOptions(partial, plan)).toThrow();
        partial.GroupRatio.partner = 0.2;
        partial.GroupRatio.enterprise = 0.19;
        expect(() => assertRecoverableGroupOptions(partial, plan)).toThrow();
    });
    it('waits for all runtime models and the selected ratio to converge', () => {
        const f = groupFixture(),
            plan = build(f);
        expect(() => assertGroupRuntime(f.runtime, plan, true)).toThrow();
        const next = structuredClone(f.runtime);
        next.group_ratio.enterprise = 0.18;
        expect(() => assertGroupRuntime(next, plan, true)).not.toThrow();
        next.models[0].billing_expr = EXPRESSION;
        expect(() => assertGroupRuntime(next, plan, true)).toThrow();
    });
    it('prices ordinary ratio models with existing cache ratios, without a second quota conversion', () => {
        const f = groupFixture();
        (f.source.options['billing_setting.billing_mode'] as Record<string, string>)['gpt-5.5'] = 'ratio';
        f.runtime.models[0].billing_mode = 'ratio';
        delete f.runtime.models[0].billing_expr;
        const plan = build(f);
        expect(plan.target).toEqual({
            ModelRatio: { 'gpt-5.5': 2.5 },
            CompletionRatio: { 'gpt-5.5': 6 },
            GroupRatio: { enterprise: 0.18 },
        });
        expect(plan.rows[0].after_details?.tiers[0].rates).toMatchObject({ input: 0.9, output: 5.4, cache_read: 0.09 });
        expect(plan.customer_overrides[0].before.tiers[0].rates.input).toBe(0.9);
        expect(plan.rows[0].cost_cny_per_1m).toBe(0.65);
        f.input.cache_read_cny_per_1m = 0.1;
        expect(() => build(f)).toThrow('缓存');
    });
    it('checks image dedicated prices instead of omitting them', () => {
        const f = groupFixture();
        f.state.models[0].modality = 'image';
        f.input = { ...f.input, input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: 0.18 };
        delete f.input.cache_read_cny_per_1m;
        (f.source.options['billing_setting.billing_mode'] as Record<string, string>)['gpt-5.5'] = 'standard';
        (f.source.options.ModelPrice as Record<string, number>)['gpt-5.5'] = 1;
        f.runtime.models[0].billing_mode = 'standard';
        f.runtime.models[0].quota_type = 1;
        f.runtime.models[0].model_price = 1;
        const plan = build(f);
        expect(plan.customer_request_overrides).toEqual([
            {
                model_id: MODEL,
                model_name: 'GPT 5.5',
                group: 'enterprise',
                ratio: 0.18,
                public_ratio: 0.18,
                count: 2,
                before_per_image_cny: 0.18,
                after_per_image_cny: 0.18,
            },
        ]);
        expect(plan.rows[0].after_details).toBeUndefined();
        expect(plan.rows[0].cost_cny_per_1m).toBe(0.65);
        const persisted = tieredPriceOptions(f.source.options);
        persisted.GroupRatio.enterprise = 0.18;
        expect(() => assertRecoverableGroupOptions(persisted, plan)).not.toThrow();
    });
});

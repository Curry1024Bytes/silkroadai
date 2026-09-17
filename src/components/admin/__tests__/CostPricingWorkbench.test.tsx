import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import CostPricingWorkbench, {
    CostConversionSummary,
    CostEstimateTable,
    CostMultiplierFields,
    CostMultiplierSummary,
    CostResolutionField,
    SavedCostRuleList,
    TieredCostPricingPreview,
} from '../CostPricingWorkbench';
import {
    costConfigFromDraft,
    costPricingPreviewBlock,
    costReviewReducer,
    costRulePublishBlock,
    costRuleSelections,
    draftFromCostConfig,
    draftWithReference,
    newCostDraft,
    prepareSingleCostPricing,
    publishCostPricingReview,
    requestCostPricingPreview,
    saveCostPricingRules,
    type CostPricingPrepared,
} from '../CostPricingWorkbench.helpers';
import { calculateCostPricing, pricingCostConfigSchema } from '@/lib/admin/pricing-cost';
import type { PricingCostCapability, PricingCostConfig, StoredPricingCostRule } from '@/lib/admin/pricing-cost-types';
import type { PricingReferenceSelection } from '../PricingReferencePicker';
import type { TieredPricingDetails } from '@/lib/admin/pricing-publish-types';
import { scaleTieredPricingDetails } from '@/lib/models/tiered-pricing-details';

const config: PricingCostConfig = {
    version: 1,
    basis: 'token',
    currency: 'credits',
    credits_per_cny: 10,
    upstream_multiplier: 0.5,
    markup_percent: 50,
    source_note: 'Supplier quote, 2026-09-15',
    token_rates: { input: 4, output: 20, cache_read: null, cache_write: null },
    variants: [],
};
const rule: StoredPricingCostRule = {
    id: 'rule-1',
    model_id: 'model-1',
    tier: 'standard',
    channel_id: 5,
    upstream_model: 'text-model',
    revision: 3,
    config,
    updated_at: '2026-09-15T02:00:00.000Z',
    mapping_current: true,
};
const capability: PricingCostCapability = {
    model_id: 'model-1',
    tier: 'standard',
    basis: 'token',
    resolution: null,
    publishable: true,
    reason: null,
};
const referencePrice: PricingReferenceSelection = {
    model: 'gpt-5.5',
    input: 5,
    output: 30,
    cache_read: 0.5,
    cache_write: null,
    sourceLabel: 'LiteLLM CDN',
    fetchedAt: '2026-09-16T08:32:14.000Z',
};
const directConfig: PricingCostConfig = {
    ...config,
    upstream_multiplier: 1.3,
    retail_multiplier: 1.6,
    markup_percent: 0,
    token_rates: { input: 5, output: 30, cache_read: 0.5, cache_write: null },
};
const prepared: CostPricingPrepared = {
    selections: [{ rule_id: rule.id, revision: rule.revision }],
    selection_token: 'private-cost-selection-token',
    cost_rows: [],
    preview: {
        preview_token: 'private-publish-token',
        expires_at: '2099-01-01T00:00:00.000Z',
        upstream_model: 'text-model',
        basis: 'token',
        warnings: [],
        rows: [
            {
                model_id: rule.model_id,
                model_name: 'Test model',
                tier: rule.tier,
                group: 'standard',
                before: { input_cny_per_1m: 0.2, output_cny_per_1m: 1, per_image_cny: null },
                after: { input_cny_per_1m: 0.3, output_cny_per_1m: 1.5, per_image_cny: null },
            },
        ],
    },
};
const tieredDetails: TieredPricingDetails = {
    version: 1,
    mode: 'tiered_token',
    unit: 'cny_per_million_tokens',
    semantics: 'whole_request',
    tiers: [
        {
            name: 'base',
            min_input_tokens: null,
            max_input_tokens: 272000,
            min_inclusive: false,
            max_inclusive: false,
            rates: { input: 0.8, output: 4.8, cache_read: 0.08, cache_write: null, cache_write_1h: null },
        },
        {
            name: 'tier_2',
            min_input_tokens: 272000,
            max_input_tokens: null,
            min_inclusive: true,
            max_inclusive: false,
            rates: { input: 1.6, output: 7.2, cache_read: 0.16, cache_write: null, cache_write_1h: null },
        },
    ],
};
const tieredPrepared: CostPricingPrepared = {
    ...prepared,
    preview: {
        ...prepared.preview,
        publication_mode: 'tiered_token',
        unchanged: true,
        rows: [{ ...prepared.preview.rows[0], before_details: tieredDetails, after_details: tieredDetails }],
        customer_overrides: [
            {
                group: 'standard',
                ratio: 0.18,
                public_ratio: 0.16,
                count: 2,
                before: scaleTieredPricingDetails(tieredDetails, 1.125),
                after: scaleTieredPricingDetails(tieredDetails, 1.125),
            },
        ],
    },
};
const tieredCapability: PricingCostCapability = { ...capability, publication_mode: 'tiered_token' };
const uniformCapability: PricingCostCapability = { ...capability, publication_mode: 'uniform_token' };
const uniformDetails: TieredPricingDetails = {
    ...tieredDetails,
    tiers: [{ ...tieredDetails.tiers[0], name: 'uniform', max_input_tokens: null }],
};
const uniformPrepared: CostPricingPrepared = {
    ...prepared,
    preview: {
        ...prepared.preview,
        publication_mode: 'uniform_token',
        unchanged: false,
        rows: [
            {
                ...prepared.preview.rows[0],
                before: { input_cny_per_1m: 0.8, output_cny_per_1m: 4.8, per_image_cny: null },
                after: { input_cny_per_1m: 0.8, output_cny_per_1m: 4.8, per_image_cny: null },
                before_details: tieredDetails,
                after_details: uniformDetails,
            },
        ],
        customer_overrides: [
            {
                group: 'standard',
                ratio: 0.18,
                public_ratio: 0.16,
                count: 2,
                before: scaleTieredPricingDetails(tieredDetails, 1.125),
                after: scaleTieredPricingDetails(uniformDetails, 1.125),
            },
        ],
    },
};
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('complete tiered price confirmation', () => {
    const savedTieredRule: StoredPricingCostRule = { ...rule, config: directConfig };

    it('previews the existing cached draft without creating a new revision or publishing', async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(tieredPrepared)));
        const onSaved = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const result = await prepareSingleCostPricing({
            input: null,
            savedRule: savedTieredRule,
            capability: tieredCapability,
            onSaved,
        });
        expect(result.preview.unchanged).toBe(true);
        expect(result.preview.rows[0].after_details).toEqual(tieredDetails);
        expect(onSaved).not.toHaveBeenCalled();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
            action: 'preview',
            selections: [{ rule_id: rule.id, revision: rule.revision }],
        });
    });

    it('allows cache reads only for supported tiered publication and continues blocking cache writes', () => {
        expect(costRulePublishBlock(savedTieredRule, tieredCapability)).toBeNull();
        expect(costRulePublishBlock(savedTieredRule, capability)).toContain('缓存价格发布');
        expect(
            costRulePublishBlock(
                {
                    ...savedTieredRule,
                    config: { ...directConfig, token_rates: { ...directConfig.token_rates, cache_write: 0 } },
                },
                tieredCapability,
            ),
        ).toContain('缓存写入价格暂不支持发布');
    });

    it.each([
        'missing row details',
        'missing overrides',
        'invalid interval',
        'changed threshold',
        'invalid override',
        'nonfinite rate',
    ])('blocks %s before acknowledgment or publication', async (scenario) => {
        const invalid = structuredClone(tieredPrepared);
        invalid.preview.rows[0].after_details = structuredClone(tieredDetails);
        if (scenario === 'missing row details') delete invalid.preview.rows[0].after_details;
        if (scenario === 'missing overrides') delete invalid.preview.customer_overrides;
        if (scenario === 'invalid interval') invalid.preview.rows[0].after_details!.tiers[1].min_input_tokens = 300000;
        if (scenario === 'changed threshold') {
            invalid.preview.rows[0].after_details!.tiers[0].max_input_tokens = 300000;
            invalid.preview.rows[0].after_details!.tiers[1].min_input_tokens = 300000;
        }
        if (scenario === 'invalid override') invalid.preview.customer_overrides![0].count = 0;
        if (scenario === 'nonfinite rate') invalid.preview.rows[0].after_details!.tiers[0].rates.cache_read = Infinity;
        expect(costPricingPreviewBlock(invalid.preview)).toContain('阶梯价格详情不完整');
        expect(
            costReviewReducer({ prepared: invalid, confirmed: false }, { type: 'confirm', confirmed: true }).confirmed,
        ).toBe(false);
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        await expect(publishCostPricingReview(invalid)).rejects.toThrow('阶梯价格详情不完整');
        expect(fetcher).not.toHaveBeenCalled();
        const html = renderToStaticMarkup(
            <TieredCostPricingPreview preview={invalid.preview} en={false} isDark={false} />,
        );
        expect(html).toContain('role="alert"');
        expect(html).not.toContain('¥0.8');
    });

    it('rejects a flat preview response for a tiered capability', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(prepared))));
        await expect(
            prepareSingleCostPricing({
                input: null,
                savedRule: savedTieredRule,
                capability: tieredCapability,
                onSaved: vi.fn(),
            }),
        ).rejects.toThrow('未返回完整阶梯价格预览');
    });

    it.each([false, true])('shows every tier, cache and replacement override in both themes (dark=%s)', (isDark) => {
        const html = renderToStaticMarkup(
            <TieredCostPricingPreview preview={tieredPrepared.preview} en={false} isDark={isDark} />,
        );
        for (const text of [
            'base',
            'tier_2',
            '272,000',
            '¥0.08',
            '¥0.16',
            '¥7.2',
            '¥0.09',
            '¥8.1',
            '计划价与 new-api 当前价格一致',
            '不重复写入',
            '客户专属倍率替代公共分组倍率',
            '整次请求',
        ])
            expect(html).toContain(text);
        expect(html).not.toContain('private-publish-token');
        expect(html).not.toContain('发布成功');
    });

    it('keeps fifth-decimal cached retail prices visible in estimates and tier comparisons', () => {
        const precise = { ...directConfig, retail_multiplier: 1.625 };
        const estimate = renderToStaticMarkup(
            <CostEstimateTable
                lines={calculateCostPricing(precise).lines}
                config={precise}
                en={false}
                isDark={false}
            />,
        );
        expect(estimate).toContain('¥0.08125');
        const preview = structuredClone(tieredPrepared.preview);
        preview.unchanged = false;
        preview.rows[0].after_details = scaleTieredPricingDetails(tieredDetails, 1.625 / 1.6);
        const html = renderToStaticMarkup(<TieredCostPricingPreview preview={preview} en={false} isDark={false} />);
        expect(html).toContain('¥0.08125');
        expect(html).toContain('¥0.1625');
        expect(html).not.toContain('不重复写入上游价格');
    });

    it('publishes a complete unchanged review with the original signed tokens and saved revision', async () => {
        const job = { id: 'verified-tiered-job', status: 'succeeded' };
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job }), { status: 202 }));
        vi.stubGlobal('fetch', fetcher);
        expect(await publishCostPricingReview(tieredPrepared)).toEqual(job);
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
            action: 'publish',
            selections: tieredPrepared.selections,
            selection_token: tieredPrepared.selection_token,
            preview_token: tieredPrepared.preview.preview_token,
        });
    });
});

describe('uniform customer price confirmation', () => {
    const savedRule: StoredPricingCostRule = { ...rule, config: directConfig };

    it('previews the saved base price and multiplier as one price without saving or publishing', async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(uniformPrepared)));
        const onSaved = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const result = await prepareSingleCostPricing({
            input: null,
            savedRule,
            capability: uniformCapability,
            onSaved,
        });
        expect(costPricingPreviewBlock(result.preview)).toBeNull();
        expect(result.preview.rows[0].before_details!.tiers).toHaveLength(2);
        expect(result.preview.rows[0].after_details!.tiers).toEqual(uniformDetails.tiers);
        expect(onSaved).not.toHaveBeenCalled();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ action: 'preview', selections: result.selections });
    });

    it('allows cache-read publication for uniform prices while keeping unsupported cache-write blocked', () => {
        expect(costRulePublishBlock(savedRule, uniformCapability)).toBeNull();
        expect(
            costRulePublishBlock(
                {
                    ...savedRule,
                    config: {
                        ...directConfig,
                        token_rates: { ...directConfig.token_rates, cache_write: 1 },
                    },
                },
                uniformCapability,
            ),
        ).toContain('缓存写入价格暂不支持发布');
    });

    it.each([
        'missing old prices',
        'missing new prices',
        'tiered target',
        'wrong target name',
        'nonfinite cache',
        'scalar mismatch',
        'missing overrides',
        'tiered override',
    ])('blocks incomplete or nonuniform %s without sending a publication request', async (scenario) => {
        const invalid = structuredClone(uniformPrepared);
        if (scenario === 'missing old prices') delete invalid.preview.rows[0].before_details;
        if (scenario === 'missing new prices') delete invalid.preview.rows[0].after_details;
        if (scenario === 'tiered target') invalid.preview.rows[0].after_details = tieredDetails;
        if (scenario === 'wrong target name') invalid.preview.rows[0].after_details!.tiers[0].name = 'base';
        if (scenario === 'nonfinite cache') invalid.preview.rows[0].after_details!.tiers[0].rates.cache_read = Infinity;
        if (scenario === 'scalar mismatch') invalid.preview.rows[0].after.input_cny_per_1m = 2;
        if (scenario === 'missing overrides') delete invalid.preview.customer_overrides;
        if (scenario === 'tiered override') invalid.preview.customer_overrides![0].after = tieredDetails;
        expect(costPricingPreviewBlock(invalid.preview)).toContain('统一价格详情不完整');
        expect(
            costReviewReducer({ prepared: invalid, confirmed: false }, { type: 'confirm', confirmed: true }).confirmed,
        ).toBe(false);
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        await expect(publishCostPricingReview(invalid)).rejects.toThrow('统一价格详情不完整');
        expect(fetcher).not.toHaveBeenCalled();
        const html = renderToStaticMarkup(
            <TieredCostPricingPreview preview={invalid.preview} en={false} isDark={false} />,
        );
        expect(html).toContain('role="alert"');
        expect(html).not.toContain('¥0.8');
    });

    it('rejects the old tier-preserving preview when a uniform price was requested', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(tieredPrepared))));
        await expect(
            prepareSingleCostPricing({ input: null, savedRule, capability: uniformCapability, onSaved: vi.fn() }),
        ).rejects.toThrow('未返回完整统一价格预览');
    });

    it.each([false, true])(
        'shows only published rates and customer prices without old length comparisons (dark=%s)',
        (isDark) => {
            const html = renderToStaticMarkup(
                <TieredCostPricingPreview preview={uniformPrepared.preview} en={false} isDark={isDark} />,
            );
            for (const text of [
                '发布后售价',
                '¥0.8',
                '¥4.8',
                '¥0.08',
                '¥0.9',
                '¥5.4',
                '¥0.09',
                '客户专属倍率替代公共分组倍率',
            ])
                expect(html).toContain(text);
            expect(html).not.toContain('现有阶梯条件保持不变');
            expect(html).not.toContain('普通档');
            expect(html).not.toContain('<details');
            expect(html).not.toContain('查看当前价格对比');
            expect(html).not.toContain('272,000');
            expect(html).not.toContain('¥7.2');
            expect(html).not.toContain('缓存写入');
            expect(html).not.toContain('private-publish-token');
        },
    );

    it('retains the supplied independent output and precise cache prices for every length', () => {
        const precise = structuredClone(uniformPrepared);
        precise.preview.rows[0].after_details!.tiers[0].rates.output = 5;
        precise.preview.rows[0].after_details!.tiers[0].rates.cache_read = 0.08125;
        precise.preview.rows[0].after.output_cny_per_1m = 5;
        expect(costPricingPreviewBlock(precise.preview)).toBeNull();
        const html = renderToStaticMarkup(
            <TieredCostPricingPreview preview={precise.preview} en={true} isDark={false} />,
        );
        expect(html).toContain('¥0.08125');
        expect(html).toContain('Customer prices after publication');
        expect(html).not.toContain('View current pricing for comparison');
    });

    it('publishes only the complete reviewed signed uniform plan', async () => {
        const job = { id: 'uniform-job', status: 'pending' };
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job }), { status: 202 }));
        vi.stubGlobal('fetch', fetcher);
        const state = costReviewReducer(
            { prepared: uniformPrepared, confirmed: false },
            { type: 'confirm', confirmed: true },
        );
        expect(state.confirmed).toBe(true);
        expect(await publishCostPricingReview(state.prepared!)).toEqual(job);
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
            action: 'publish',
            selections: uniformPrepared.selections,
            selection_token: uniformPrepared.selection_token,
            preview_token: uniformPrepared.preview.preview_token,
        });
    });
});

describe('cost forms preserve actual purchasing inputs', () => {
    it('does not assume prices, supplier multipliers or retail multipliers in a new form', () => {
        const draft = newCostDraft(capability);
        expect(draft.token_rates).toEqual({ input: '', output: '', cache_read: '', cache_write: '' });
        expect(draft.upstream_multiplier).toBe('');
        expect(draft.retail_multiplier).toBe('');
        expect(costConfigFromDraft(draft)).toBeNull();
    });
    it('uses actual credit redemption and supplier multiplier once, then markup once', () => {
        const roundTrip = costConfigFromDraft(draftFromCostConfig(config));
        expect(roundTrip).toEqual(config);
        expect(calculateCostPricing(roundTrip!).lines[0]).toMatchObject({
            cost: 0.2,
            retail: 0.3,
            profit: 0.1,
            margin_percent: 33.3333,
        });
    });
    it('keeps a legacy quote and its pricing semantics when only the note changes', () => {
        const draft = draftFromCostConfig(config);
        expect(draft.retail_multiplier).toBe('0.75');
        draft.source_note = 'Supplier quote rechecked';
        const saved = costConfigFromDraft(draft);
        expect(saved).toEqual({ ...config, source_note: 'Supplier quote rechecked' });
        expect(saved).not.toHaveProperty('retail_multiplier');
        expect(calculateCostPricing(saved!).lines).toEqual(calculateCostPricing(config).lines);
    });
    it('preserves a valid legacy target above the direct-input limit when opening or editing its quote and note', () => {
        const legacy: PricingCostConfig = {
            ...config,
            currency: 'cny',
            credits_per_cny: 1,
            upstream_multiplier: 1e15,
            markup_percent: 1900,
            token_rates: { input: 1e-15, output: 1e-15, cache_read: null, cache_write: null },
        };
        const draft = draftFromCostConfig(legacy);
        expect(draft.retail_multiplier).toBe('20000000000000000');
        expect(costConfigFromDraft(draft)).toEqual(legacy);
        expect(calculateCostPricing(costConfigFromDraft(draft)!).lines[0]).toMatchObject({ cost: 1, retail: 20 });
        const edited = costConfigFromDraft({
            ...draft,
            source_note: 'Quote rechecked',
            token_rates: { ...draft.token_rates, input: '2e-15' },
        });
        expect(edited).not.toHaveProperty('retail_multiplier');
        expect(edited?.source_note).toBe('Quote rechecked');
        expect(calculateCostPricing(edited!).lines[0]).toMatchObject({ cost: 2, retail: 40 });
        const converted = costConfigFromDraft({ ...draft, upstream_multiplier: '2e15' });
        expect(converted).toMatchObject({ retail_multiplier: 2e16, markup_percent: 0 });
        expect(pricingCostConfigSchema.safeParse(converted).success).toBe(false);
    });
    it('uses one target of 1.6 for batch rules while retaining each quote and supplier multiplier', () => {
        const configs = [
            { ...config, upstream_multiplier: 1.3 },
            { ...config, upstream_multiplier: 1.4, token_rates: { ...config.token_rates, input: 6 } },
        ];
        const next = configs.map((saved) =>
            costConfigFromDraft({ ...draftFromCostConfig(saved), retail_multiplier: '1.6' }),
        );
        expect(next[0]).toEqual({ ...configs[0], retail_multiplier: 1.6, markup_percent: 0 });
        expect(next[1]).toEqual({ ...configs[1], retail_multiplier: 1.6, markup_percent: 0 });
        expect(calculateCostPricing(next[0]!).lines[0]).toMatchObject({ cost: 0.52, retail: 0.64, profit: 0.12 });
        expect(calculateCostPricing(next[1]!).lines[0]).toMatchObject({ cost: 0.84, retail: 0.96, profit: 0.12 });
        expect(costConfigFromDraft({ ...draftFromCostConfig(configs[1]), retail_multiplier: '1.3' })).toBeNull();
    });
    it('does not apply a stale credit exchange rate to CNY quotes', () => {
        const draft = { ...draftFromCostConfig(config), currency: 'cny' as const };
        expect(costConfigFromDraft(draft)?.credits_per_cny).toBe(1);
    });
    it('fills a confirmed reference quote while retaining the credit conversion and both multipliers exactly once', () => {
        const original = draftFromCostConfig(directConfig);
        const draft = draftWithReference(original, referencePrice);
        expect(draft).toMatchObject({
            currency: 'credits',
            credits_per_cny: '10',
            upstream_multiplier: '1.3',
            retail_multiplier: '1.6',
            token_rates: { input: '5', output: '30', cache_read: '0.5', cache_write: '' },
        });
        expect(original.source_note).toBe(config.source_note);
        expect(draft.source_note).toContain('LiteLLM CDN');
        expect(draft.source_note).toContain(referencePrice.fetchedAt);
        expect(draft.source_note).toContain(config.source_note);
        expect(draft.source_note).toContain('用于基础报价与成本估算');
        const saved = costConfigFromDraft(draft);
        expect(saved?.token_rates.cache_write).toBeNull();
        expect(calculateCostPricing(saved!).lines).toEqual([
            expect.objectContaining({ key: 'input', cost: 0.65, retail: 0.8, profit: 0.15 }),
            expect.objectContaining({ key: 'output', cost: 3.9, retail: 4.8, profit: 0.9 }),
            expect.objectContaining({ key: 'cache_read', cost: 0.065, retail: 0.08, profit: 0.015 }),
        ]);
    });
    it('requires the real recharge ratio after changing a CNY draft to the reference credit basis', () => {
        const draft = draftWithReference(
            draftFromCostConfig({ ...directConfig, currency: 'cny', credits_per_cny: 1 }),
            referencePrice,
        );
        expect(draft).toMatchObject({
            currency: 'credits',
            credits_per_cny: '',
            upstream_multiplier: '1.3',
            retail_multiplier: '1.6',
        });
        expect(costConfigFromDraft(draft)).toBeNull();
        const saved = costConfigFromDraft({ ...draft, credits_per_cny: '10' });
        expect(calculateCostPricing(saved!).lines[0]).toMatchObject({ cost: 0.65, retail: 0.8 });
    });
    it('keeps missing reference cache prices distinct from explicitly quoted zero', () => {
        const draft = draftFromCostConfig(directConfig);
        const missing = draftWithReference(draft, { ...referencePrice, cache_read: null, cache_write: null });
        expect(missing.token_rates).toMatchObject({ cache_read: '', cache_write: '' });
        expect(costConfigFromDraft(missing)?.token_rates).toMatchObject({ cache_read: null, cache_write: null });
        const zero = draftWithReference(draft, { ...referencePrice, cache_read: 0, cache_write: 0 });
        expect(zero.token_rates).toMatchObject({ cache_read: '0', cache_write: '0' });
        expect(costConfigFromDraft(zero)?.token_rates).toMatchObject({ cache_read: 0, cache_write: 0 });
    });
    it('bounds reference provenance notes without losing the reference source and pricing basis', () => {
        const draft = draftWithReference(
            { ...draftFromCostConfig(directConfig), source_note: 'Existing note '.repeat(100) },
            referencePrice,
        );
        expect(draft.source_note).toHaveLength(500);
        expect(draft.source_note).toContain('LiteLLM CDN · gpt-5.5');
        expect(draft.source_note).toContain('USD 基准数字按上游额度计价');
        expect(pricingCostConfigSchema.safeParse(costConfigFromDraft(draft)).success).toBe(true);
    });
    it('distinguishes an omitted cache cost from explicit zero', () => {
        const draft = draftFromCostConfig(config);
        expect(costConfigFromDraft(draft)?.token_rates.cache_read).toBeNull();
        draft.token_rates.cache_read = '0';
        expect(costConfigFromDraft(draft)?.token_rates.cache_read).toBe(0);
    });
    it.each(['', '-1', 'NaN', 'Infinity'])('rejects missing or invalid quote %s', (value) => {
        const draft = draftFromCostConfig(config);
        draft.token_rates.input = value;
        expect(costConfigFromDraft(draft)).toBeNull();
    });
    it('uses the fixed image resolution, without assuming its cost', () => {
        const draft = newCostDraft({ ...capability, basis: 'image', resolution: '2k' });
        expect(draft.variants[0]).toMatchObject({ resolution: '2k', price: '', minimum_units: '1', step_units: '1' });
        expect(costConfigFromDraft(draft)).toBeNull();
    });
    it('requires video time rounding instead of silently assuming one second', () => {
        const draft = newCostDraft({ ...capability, basis: 'video' });
        draft.upstream_multiplier = '1';
        draft.retail_multiplier = '1.5';
        draft.variants[0].price = '0.2';
        expect(draft.variants[0].minimum_units).toBe('');
        expect(draft.variants[0].step_units).toBe('');
        expect(costConfigFromDraft(draft)).toBeNull();
        draft.variants[0].minimum_units = '5';
        draft.variants[0].step_units = '1';
        expect(costConfigFromDraft(draft)?.variants[0]).toMatchObject({ minimum_units: 5, step_units: 1 });
    });
    it('uses the actual multiplier field callbacks to discard signed review before edits and preserves the target when supplier costs change', () => {
        let draft = { ...draftFromCostConfig(config), upstream_multiplier: '1.3', retail_multiplier: '1.6' };
        let review = costReviewReducer({ prepared: null, confirmed: false }, { type: 'prepare', prepared });
        review = costReviewReducer(review, { type: 'confirm', confirmed: true });
        const events: string[] = [];
        const fields = () =>
            CostMultiplierFields({
                draft,
                en: false,
                className: '',
                onInvalidate: () => {
                    events.push('invalidate');
                    review = costReviewReducer(review, { type: 'invalidate' });
                },
                onChange: (next) => {
                    events.push('change');
                    draft = next;
                },
            }).props.children;
        fields()[0].props.onChange('1.5');
        expect(events).toEqual(['invalidate', 'change']);
        expect(draft).toMatchObject({ upstream_multiplier: '1.5', retail_multiplier: '1.6' });
        expect(review).toEqual({ prepared: null, confirmed: false });
        expect(costConfigFromDraft(draft)?.retail_multiplier).toBe(1.6);
        review = costReviewReducer(review, { type: 'prepare', prepared });
        review = costReviewReducer(review, { type: 'confirm', confirmed: true });
        fields()[1].props.onChange('1.7');
        expect(draft).toMatchObject({ upstream_multiplier: '1.5', retail_multiplier: '1.7' });
        expect(review).toEqual({ prepared: null, confirmed: false });
        fields()[0].props.onChange('1.8');
        expect(draft.retail_multiplier).toBe('1.7');
        expect(costConfigFromDraft(draft)).toBeNull();
        expect(events).toEqual(['invalidate', 'change', 'invalidate', 'change', 'invalidate', 'change']);
    });
});

describe('saved selections and supported billing', () => {
    it('selects only saved rows and binds their saved revisions in stable order', () => {
        const second = { ...rule, id: 'rule-2', revision: 6 };
        expect(costRuleSelections([second, rule], ['rule-2', 'unknown-rule', 'rule-1'])).toEqual([
            { rule_id: 'rule-1', revision: 3 },
            { rule_id: 'rule-2', revision: 6 },
        ]);
    });
    it('includes the explicit specification when selecting a saved image rule', () => {
        const imageRule = {
            ...rule,
            config: {
                ...config,
                basis: 'image' as const,
                token_rates: { input: null, output: null, cache_read: null, cache_write: null },
                variants: [
                    {
                        key: 'image_2k',
                        label: '2K',
                        resolution: '2k',
                        audio: 'any' as const,
                        reference_video: 'any' as const,
                        price: 0.8,
                        minimum_units: 1,
                        step_units: 1,
                    },
                ],
            },
        };
        expect(costRuleSelections([imageRule], [rule.id])).toEqual([
            { rule_id: rule.id, revision: 3, variant_key: 'image_2k' },
        ]);
        const imageCapability = { ...capability, basis: 'image' as const, resolution: '2k' };
        expect(costRulePublishBlock(imageRule, imageCapability)).toBeNull();
        expect(
            costRulePublishBlock(
                {
                    ...imageRule,
                    config: {
                        ...imageRule.config,
                        variants: [{ ...imageRule.config.variants[0], resolution: ' 2K ' }],
                    },
                },
                imageCapability,
            ),
        ).toBeNull();
        expect(costRulePublishBlock(imageRule, { ...imageCapability, resolution: '4k' })).toContain('4k');
        expect(costRulePublishBlock(imageRule, { ...imageCapability, resolution: null })).toContain('default');
        const minimumRule = {
            ...imageRule,
            config: { ...imageRule.config, variants: [{ ...imageRule.config.variants[0], minimum_units: 2 }] },
        };
        expect(costRulePublishBlock(minimumRule, imageCapability)).toContain('逐张计费');
    });
    it('blocks changed mappings, unavailable capabilities and unsupported cache publication', () => {
        expect(costRulePublishBlock({ ...rule, mapping_current: false }, capability)).toContain('登记渠道已变化');
        expect(costRulePublishBlock(rule, undefined)).toContain('当前未支持发布');
        expect(
            costRulePublishBlock(
                { ...rule, config: { ...config, token_rates: { ...config.token_rates, cache_read: 0 } } },
                capability,
            ),
        ).toContain('尚未支持缓存价格发布');
        expect(costRulePublishBlock(rule, capability)).toBeNull();
    });
    it('invalidates signed preview and confirmation for any edit or selection change', () => {
        let review = costReviewReducer({ prepared: null, confirmed: false }, { type: 'prepare', prepared });
        review = costReviewReducer(review, { type: 'confirm', confirmed: true });
        expect(review.confirmed).toBe(true);
        review = costReviewReducer(review, { type: 'invalidate' });
        expect(review).toEqual({ prepared: null, confirmed: false });
        expect(costReviewReducer(review, { type: 'confirm', confirmed: true }).confirmed).toBe(false);
        expect(costReviewReducer(review, { type: 'prepare', prepared }).confirmed).toBe(false);
    });
});

describe('cost saving and publication requests', () => {
    it('saves the current editor before notifying the UI and previews only the returned revision without publishing', async () => {
        const saved = { ...rule, revision: 4 };
        const events: string[] = [];
        const onSaved = vi.fn((value: StoredPricingCostRule) => {
            events.push('saved');
            expect(value).toEqual(saved);
        });
        const fetcher = vi
            .fn()
            .mockImplementationOnce(async () => {
                events.push('save-request');
                return new Response(JSON.stringify({ rule: saved }));
            })
            .mockImplementationOnce(async () => {
                events.push('preview-request');
                expect(onSaved).toHaveBeenCalledTimes(1);
                return new Response(JSON.stringify(prepared));
            });
        vi.stubGlobal('fetch', fetcher);
        const input = { model_id: rule.model_id, tier: rule.tier, expected_revision: rule.revision, config };
        const review = await prepareSingleCostPricing({ input, savedRule: rule, capability, onSaved });
        expect(events).toEqual(['save-request', 'saved', 'preview-request']);
        expect(review.selections).toEqual([{ rule_id: saved.id, revision: 4 }]);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls[0][0]).toBe('/api/admin/pricing/cost-rules');
        expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toEqual(input);
        expect(fetcher.mock.calls[1][0]).toBe('/api/admin/pricing/cost-rules/publish');
        expect(JSON.parse(String(fetcher.mock.calls[1][1].body))).toEqual({
            action: 'preview',
            selections: [{ rule_id: saved.id, revision: 4 }],
        });
    });
    it('previews an unchanged saved rule without saving a duplicate cost revision', async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(prepared)));
        const onSaved = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const review = await prepareSingleCostPricing({ input: null, savedRule: rule, capability, onSaved });
        expect(review.selections).toEqual([{ rule_id: rule.id, revision: rule.revision }]);
        expect(onSaved).not.toHaveBeenCalled();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toEqual({
            action: 'preview',
            selections: [{ rule_id: rule.id, revision: rule.revision }],
        });
    });
    it('keeps the saved revision visible when preview fails and does not roll back, retry, or publish', async () => {
        const saved = { ...rule, revision: 4 };
        let visibleRule = rule;
        const onSaved = vi.fn((value: StoredPricingCostRule) => {
            visibleRule = value;
        });
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ rule: saved })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'new-api 暂时不可用' }), { status: 502 }));
        vi.stubGlobal('fetch', fetcher);
        await expect(
            prepareSingleCostPricing({
                input: { model_id: rule.model_id, tier: rule.tier, expected_revision: rule.revision, config },
                savedRule: rule,
                capability,
                onSaved,
            }),
        ).rejects.toThrow('成本已保存，发布预览未完成，客户售价未变。new-api 暂时不可用');
        expect(visibleRule).toEqual(saved);
        expect(onSaved).toHaveBeenCalledTimes(1);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls.map((call) => JSON.parse(String(call[1].body)).action)).toEqual([
            undefined,
            'preview',
        ]);
    });
    it('stops at a conflicting save without notifying a saved revision or trying to preview', async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValue(
                new Response(JSON.stringify({ message: '成本规则已更新，请重新加载。' }), { status: 409 }),
            );
        const onSaved = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        await expect(
            prepareSingleCostPricing({
                input: { model_id: rule.model_id, tier: rule.tier, expected_revision: 1, config },
                savedRule: rule,
                capability,
                onSaved,
            }),
        ).rejects.toThrow('成本规则已更新');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(onSaved).not.toHaveBeenCalled();
    });
    it.each([
        {
            name: 'dynamic billing',
            saved: rule,
            supported: { ...capability, publishable: false, reason: '动态阶梯计费暂不支持发布。' },
            message: '动态阶梯计费暂不支持发布',
        },
        {
            name: 'cache price including zero',
            saved: { ...rule, config: { ...config, token_rates: { ...config.token_rates, cache_read: 0 } } },
            supported: capability,
            message: '尚未支持缓存价格发布',
        },
    ])(
        'keeps $name blocked in the single-model shortcut without any preview or publication request',
        async ({ saved, supported, message }) => {
            const fetcher = vi.fn();
            const onSaved = vi.fn();
            vi.stubGlobal('fetch', fetcher);
            await expect(
                prepareSingleCostPricing({ input: null, savedRule: saved, capability: supported, onSaved }),
            ).rejects.toThrow(message);
            expect(fetcher).not.toHaveBeenCalled();
            expect(onSaved).not.toHaveBeenCalled();
        },
    );
    it('checks publication eligibility against the returned saved rule before attempting a preview', async () => {
        const saved = { ...rule, revision: 4, mapping_current: false };
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ rule: saved })));
        const onSaved = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        await expect(
            prepareSingleCostPricing({
                input: { model_id: rule.model_id, tier: rule.tier, expected_revision: rule.revision, config },
                savedRule: rule,
                capability,
                onSaved,
            }),
        ).rejects.toThrow('成本已保存，发布预览未完成，客户售价未变。登记渠道已变化');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(onSaved).toHaveBeenCalledWith(saved);
    });
    it('requires a saved rule when there are no editor changes to save', async () => {
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        await expect(prepareSingleCostPricing({ input: null, capability, onSaved: vi.fn() })).rejects.toThrow(
            '请先保存成本规则',
        );
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('saves one cost rule with the editing revision, without publishing or writing retail amounts', async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ rule })));
        vi.stubGlobal('fetch', fetcher);
        const input = { model_id: rule.model_id, tier: rule.tier, expected_revision: 2, config };
        expect(await saveCostPricingRules([input])).toEqual([rule]);
        expect(fetcher).toHaveBeenCalledWith(
            '/api/admin/pricing/cost-rules',
            expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: JSON.stringify(input) }),
        );
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).not.toHaveProperty('input_cny_per_1m');
    });
    it('saves batch retail multipliers for exact saved model/tier revisions with independent input snapshots', async () => {
        let respond!: (value: Response) => void;
        const fetcher = vi.fn<typeof fetch>(
            () =>
                new Promise<Response>((resolve) => {
                    respond = resolve;
                }),
        );
        vi.stubGlobal('fetch', fetcher);
        const inputs = [
            {
                model_id: 'model-1',
                tier: 'standard',
                expected_revision: 3,
                config: { ...config, markup_percent: 0, retail_multiplier: 0.8 },
            },
            {
                model_id: 'model-2',
                tier: 'premium',
                expected_revision: 5,
                config: { ...config, markup_percent: 0, retail_multiplier: 0.8 },
            },
        ];
        const pending = saveCostPricingRules(inputs);
        inputs[0].config.retail_multiplier = 999;
        respond(new Response(JSON.stringify({ rules: [rule, { ...rule, id: 'rule-2' }] })));
        await pending;
        expect(fetcher.mock.calls[0][0]).toBe('/api/admin/pricing/cost-rules/bulk');
        expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
            rules: [
                { expected_revision: 3, config: { retail_multiplier: 0.8 } },
                { model_id: 'model-2', tier: 'premium', expected_revision: 5, config: { retail_multiplier: 0.8 } },
            ],
        });
    });
    it('preview sends saved revisions without publishing and retains exact selections across the await', async () => {
        let respond!: (value: Response) => void;
        const fetcher = vi.fn<typeof fetch>(
            () =>
                new Promise<Response>((resolve) => {
                    respond = resolve;
                }),
        );
        vi.stubGlobal('fetch', fetcher);
        const selections = [{ rule_id: 'rule-1', revision: 3 }];
        const pending = requestCostPricingPreview(selections);
        selections[0].revision = 99;
        respond(new Response(JSON.stringify(prepared)));
        expect((await pending).selections).toEqual([{ rule_id: 'rule-1', revision: 3 }]);
        expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
            action: 'preview',
            selections: [{ rule_id: 'rule-1', revision: 3 }],
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('sends both signed tokens and exactly the reviewed selections when publishing', async () => {
        const job = { id: 'job-1', status: 'queued' };
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job }), { status: 202 }));
        vi.stubGlobal('fetch', fetcher);
        expect(await publishCostPricingReview(prepared)).toEqual(job);
        expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
            action: 'publish',
            selections: prepared.selections,
            selection_token: prepared.selection_token,
            preview_token: prepared.preview.preview_token,
        });
    });
    it('refuses expired previews without sending a publish request', async () => {
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        await expect(
            publishCostPricingReview({
                ...prepared,
                preview: { ...prepared.preview, expires_at: '2000-01-01T00:00:00Z' },
            }),
        ).rejects.toThrow('预览已过期');
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('does not mistake legacy immediate price save for a verified publication task', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(new Response(JSON.stringify({ price: {}, sync: { ok: true } }))),
        );
        await expect(publishCostPricingReview(prepared)).rejects.toThrow('任务响应不完整');
    });
    it('preserves conflict messages, so a newer saved cost cannot be silently overwritten', async () => {
        vi.stubGlobal(
            'fetch',
            vi
                .fn()
                .mockResolvedValue(
                    new Response(JSON.stringify({ message: '成本规则已更新，请重新加载。' }), { status: 409 }),
                ),
        );
        await expect(
            saveCostPricingRules([{ model_id: rule.model_id, tier: rule.tier, expected_revision: 1, config }]),
        ).rejects.toThrow('成本规则已更新');
    });
});

describe('cost pricing UI semantics', () => {
    it('presents one direct retail multiplier field and states that its base quote excludes multipliers', () => {
        const html = renderToStaticMarkup(
            <CostMultiplierFields
                draft={{ ...draftFromCostConfig(config), upstream_multiplier: '1.3', retail_multiplier: '1.6' }}
                en={false}
                className=""
                onChange={() => {}}
                onInvalidate={() => {}}
            />,
        );
        expect(html.match(/<input/g)).toHaveLength(2);
        expect(html).toContain('上游倍率');
        expect(html).toContain('我的售价倍率');
        expect(html).toContain('value="1.3"');
        expect(html).toContain('value="1.6"');
        expect(html).toContain('按下方基础报价计算成本');
        expect(html).toContain('报价已含上游倍率时填 1');
        expect(html).toContain('售价倍率也以这份报价为基准');
        expect(html).toContain('不能低于上游倍率');
        expect(html).not.toMatch(/加价（%）|Markup|<select/);
    });
    it.each([false, true])(
        'shows supplier-to-retail multipliers and the increment without floating-point noise (en=%s)',
        (en) => {
            const html = renderToStaticMarkup(<CostMultiplierSummary upstream="1.3" retail="1.6" en={en} />);
            expect(html).toContain(
                en ? 'Supplier 1.3× → Retail 1.6× (+0.3×)' : '上游 1.3 倍 → 售价 1.6 倍（加 0.3 倍）',
            );
            expect(html).not.toContain('0.300000000');
            expect(renderToStaticMarkup(<CostMultiplierSummary upstream="1.3" retail="" en={en} />)).toBe('');
            expect(renderToStaticMarkup(<CostMultiplierSummary upstream="1.3" retail="1.2" en={en} />)).toBe('');
            expect(renderToStaticMarkup(<CostMultiplierSummary upstream="1.3" retail="Infinity" en={en} />)).toBe('');
        },
    );
    it('displays a valid legacy derived retail multiplier above the direct-input limit', () => {
        const html = renderToStaticMarkup(
            <CostMultiplierSummary upstream="1000000000000000" retail="20000000000000000" en={false} />,
        );
        expect(html).toContain('上游 1000000000000000 倍 → 售价 20000000000000000 倍（加 19000000000000000 倍）');
    });
    it.each([false, true])(
        'shows direct and legacy saved targets consistently without markup percentages (dark=%s)',
        (isDark) => {
            const html = renderToStaticMarkup(
                <SavedCostRuleList
                    rules={[
                        rule,
                        {
                            ...rule,
                            id: 'rule-direct',
                            config: { ...config, markup_percent: 0, upstream_multiplier: 1.3, retail_multiplier: 1.6 },
                        },
                    ]}
                    capabilities={[capability]}
                    models={[]}
                    selectedIds={[]}
                    busy={false}
                    en={false}
                    isDark={isDark}
                    onSelect={() => {}}
                    onEdit={() => {}}
                />,
            );
            expect(html).toContain('上游 0.5 倍 → 售价 0.75 倍（加 0.25 倍）');
            expect(html).toContain('上游 1.3 倍 → 售价 1.6 倍（加 0.3 倍）');
            expect(html).not.toMatch(/加价|倍成本|50%/);
            expect(html).toContain('版本');
        },
    );
    it('keeps a mismatched saved image resolution editable without silently changing the quote', () => {
        const render = (resolution: string, fixedResolution: string | null) =>
            renderToStaticMarkup(
                <CostResolutionField
                    resolution={resolution}
                    fixedResolution={fixedResolution}
                    className=""
                    en={false}
                    onChange={() => {}}
                />,
            );
        const mismatched = render('1k', '2k');
        expect(mismatched).toContain('value="1k"');
        expect(mismatched).toContain('此模型对应 2k');
        expect(mismatched).not.toContain('readOnly');
        expect(render('2k', '2k')).toContain('readOnly');
        expect(render('2K', '2k')).toContain('readOnly');
        expect(render('default', null)).not.toContain('readOnly');
    });
    it('starts with model/tier selection and no publish confirmation or guessed price', () => {
        const html = renderToStaticMarkup(
            <CostPricingWorkbench
                models={[]}
                isDark={false}
                locale="zh"
                onPublished={() => {}}
                onUncertain={() => {}}
            />,
        );
        expect(html).toContain('计算并发布价格');
        expect(html).toContain('请选择模型');
        expect(html).toContain('请选择已登记档次');
        expect(html).not.toContain('确认并提交发布任务');
        expect(html).not.toContain('¥0');
        expect(html).not.toContain('private-publish-token');
    });
    it('shows unsupported video costs as editable estimates rather than effective prices', () => {
        const videoRule = {
            ...rule,
            config: {
                ...config,
                basis: 'video' as const,
                token_rates: { input: null, output: null, cache_read: null, cache_write: null },
                variants: [
                    {
                        key: 'video-720p',
                        label: '720p',
                        resolution: '720p',
                        audio: 'any' as const,
                        reference_video: 'any' as const,
                        price: 1,
                        minimum_units: 5,
                        step_units: 1,
                    },
                ],
            },
        };
        const html = renderToStaticMarkup(
            <SavedCostRuleList
                rules={[videoRule]}
                capabilities={[
                    { ...capability, basis: 'video', publishable: false, reason: '视频可保存和试算，当前未支持发布。' },
                ]}
                models={[{ id: rule.model_id, slug: 'video-model', display_name: 'Video model', enabled: true }]}
                selectedIds={[rule.id]}
                busy={false}
                en={false}
                isDark={false}
                onSelect={() => {}}
                onEdit={() => {}}
            />,
        );
        expect(html).toContain('视频 · 按秒试算');
        expect(html).toContain('视频可保存和试算，当前未支持发布');
        expect(html).toContain('编辑成本');
        expect(html).not.toContain('已生效');
        expect(html).not.toContain('发布成功');
    });
    it('distinguishes markup and margin in calculated results and keeps units visible', () => {
        const html = renderToStaticMarkup(
            <CostEstimateTable lines={calculateCostPricing(config).lines} en={false} isDark />,
        );
        for (const text of ['¥0.2', '¥0.3', '¥0.1', '33.33%', '/ 百万 token', '计划售价']) expect(html).toContain(text);
    });
    it.each([false, true])(
        'explains the credit conversion without asking for a second multiplier conversion (en=%s)',
        (en) => {
            const html = renderToStaticMarkup(<CostConversionSummary config={directConfig} en={en} />);
            expect(html).toContain(en ? 'Recharge ¥1 → 10 supplier credits' : '上游充值 ¥1 → 到账 10 额度');
            expect(html).toContain('¥0.13');
            expect(html).toContain('¥0.16');
            expect(html).toContain(en ? 'Do not divide the multipliers again' : '倍率不用再手动除以充值比例');
            expect(html).not.toContain('¥0.013');
            expect(html).not.toContain('¥0.016');
            expect(
                renderToStaticMarkup(<CostConversionSummary config={{ ...directConfig, currency: 'cny' }} en={en} />),
            ).toBe('');
        },
    );
    it('shows each quoted token category as supplier credits, CNY cost, and target price without summing or remultiplying', () => {
        const html = renderToStaticMarkup(
            <CostEstimateTable
                lines={calculateCostPricing(directConfig).lines}
                config={directConfig}
                en={false}
                isDark={false}
            />,
        );
        expect(html).toContain('上游扣额度');
        expect(html).toContain('折算成本（元）');
        expect(html).toContain('计划售价（元）');
        const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
            .slice(1)
            .map((row) =>
                [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) =>
                    cell[1].replace(/<[^>]*>/g, '').trim(),
                ),
            );
        expect(rows).toEqual([
            ['输入/ 百万 token', '6.5', '¥0.65', '¥0.8', '¥0.15', '18.75%'],
            ['输出/ 百万 token', '39', '¥3.9', '¥4.8', '¥0.9', '18.75%'],
            ['缓存读取/ 百万 token', '0.65', '¥0.065', '¥0.08', '¥0.015', '18.75%'],
        ]);
        expect(html).not.toContain('¥0.845');
    });
    it('renders the conversion of a valid large recharge ratio even when the per-unit estimate is below the publishable price floor', () => {
        const smallConfig: PricingCostConfig = {
            ...directConfig,
            credits_per_cny: 1e6,
            upstream_multiplier: 1,
            retail_multiplier: 1,
            token_rates: { input: 1000, output: 1000, cache_read: null, cache_write: null },
        };
        expect(pricingCostConfigSchema.safeParse(smallConfig).success).toBe(true);
        expect(calculateCostPricing(smallConfig).lines[0]).toMatchObject({ cost: 0.001, retail: 0.001 });
        const html = renderToStaticMarkup(<CostConversionSummary config={smallConfig} en={false} />);
        expect(html).toContain('到账 1000000 额度');
        expect(html.match(/¥0\.000001/g)).toHaveLength(2);
    });
    it('renders supplier credits above the CNY publication ceiling when the converted customer price is valid', () => {
        const largeConfig: PricingCostConfig = {
            ...directConfig,
            upstream_multiplier: 2,
            retail_multiplier: 2,
            token_rates: { input: 9e7, output: 9e7, cache_read: null, cache_write: null },
        };
        expect(pricingCostConfigSchema.safeParse(largeConfig).success).toBe(true);
        const calculation = calculateCostPricing(largeConfig);
        expect(calculation.lines[0]).toMatchObject({ cost: 1.8e7, retail: 1.8e7 });
        const html = renderToStaticMarkup(
            <CostEstimateTable lines={calculation.lines} config={largeConfig} en={false} isDark={false} />,
        );
        expect(html).toContain('>180,000,000<');
        expect(html).toContain('¥18,000,000');
    });
});

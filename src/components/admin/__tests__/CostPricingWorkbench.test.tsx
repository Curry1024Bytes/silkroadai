import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import CostPricingWorkbench, {
    CostEstimateTable,
    CostMultiplierFields,
    CostMultiplierSummary,
    CostResolutionField,
    SavedCostRuleList,
} from '../CostPricingWorkbench';
import {
    costConfigFromDraft,
    costReviewReducer,
    costRulePublishBlock,
    costRuleSelections,
    draftFromCostConfig,
    newCostDraft,
    publishCostPricingReview,
    requestCostPricingPreview,
    saveCostPricingRules,
    type CostPricingPrepared,
} from '../CostPricingWorkbench.helpers';
import { calculateCostPricing, pricingCostConfigSchema } from '@/lib/admin/pricing-cost';
import type { PricingCostCapability, PricingCostConfig, StoredPricingCostRule } from '@/lib/admin/pricing-cost-types';

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
afterEach(() => {
    vi.unstubAllGlobals();
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
        expect(html).toContain('按倍率定价');
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
});

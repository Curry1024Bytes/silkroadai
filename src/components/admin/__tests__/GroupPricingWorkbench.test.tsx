import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import GroupPricingWorkbench, { GroupModelQuote, GroupPricingPreview } from '../GroupPricingWorkbench';
import {
    GroupPricingRequestError,
    groupInitialDrafts,
    groupInitialSettings,
    groupModelConfig,
    groupModelIssue,
    groupPreviewInput,
    groupSettingsValue,
    publishGroupPricing,
    requestGroupPricingPreview,
    type GroupPricingPrepared,
} from '../GroupPricingWorkbench.helpers';
import { calculateCostPricing } from '@/lib/admin/pricing-cost';
import type { PricingGroupCatalog, PricingGroupModel } from '@/lib/admin/pricing-group-types';
import type { PricingCostConfig, StoredPricingCostRule } from '@/lib/admin/pricing-cost-types';

const settings = {
    currency: 'credits' as const,
    credits_per_cny: '10',
    upstream_multiplier: '1.3',
    retail_multiplier: '1.6',
};
const config: PricingCostConfig = {
    version: 1,
    basis: 'token',
    currency: 'credits',
    credits_per_cny: 10,
    upstream_multiplier: 1.3,
    retail_multiplier: 1.6,
    markup_percent: 0,
    source_note: 'supplier confirmed',
    token_rates: { input: 5, output: 30, cache_read: 0.5, cache_write: null },
    variants: [],
};
const model: PricingGroupModel = {
    id: 'row-1',
    model_id: 'model-1',
    slug: 'gpt-5.5',
    display_name: 'GPT 5.5',
    upstream_model: 'gpt-5.5',
    channel_ids: [5],
    status: 'ready',
    selectable: true,
    ready: true,
    config,
    saved_revision: 2,
    saved_rule_id: 'rule-1',
    capability: {
        model_id: 'model-1',
        tier: 'enterprise',
        basis: 'token',
        resolution: null,
        publishable: true,
        reason: null,
        publication_mode: 'uniform_token',
        required_token_rates: ['cache_read'],
    },
    reason: null,
    base_source: 'saved',
    reference_model: null,
};
const catalog: PricingGroupCatalog = {
    tier: { id: 'group-1', key: 'enterprise', label: '企业级', newapi_group: 'GPT-Pro20x' },
    fingerprint: 'before-save',
    models: [
        model,
        {
            ...model,
            id: 'row-2',
            model_id: 'model-2',
            slug: 'gpt-5.6-sol',
            display_name: 'GPT 5.6 Sol',
            upstream_model: 'gpt-5.6-sol',
            config: { ...config, token_rates: { input: 4, output: 20, cache_read: 0.4, cache_write: 5 } },
            saved_revision: 3,
            saved_rule_id: 'rule-2',
        },
    ],
    reference_error: null,
    notices: [],
    counts: { total: 2, ready: 2, needs_price: 0, unavailable: 0 },
};
function savedRules(): StoredPricingCostRule[] {
    return catalog.models.map((row) => ({
        id: row.saved_rule_id!,
        model_id: row.model_id!,
        tier: 'enterprise',
        channel_id: 5,
        upstream_model: row.upstream_model,
        revision: row.saved_revision! + 1,
        config: row.config!,
        updated_at: '2026-09-18T00:00:00Z',
        mapping_current: true,
    }));
}
function responseData() {
    const rules = savedRules();
    return {
        rules,
        selections: rules.map((row) => ({ rule_id: row.id, revision: row.revision })),
        catalog_fingerprint: 'after-save',
        selection_token: 'signed-selection',
        cost_rows: [],
        preview: {
            preview_token: 'signed-preview',
            expires_at: '2099-01-01T00:00:00Z',
            upstream_model: 'group-models',
            basis: 'token' as const,
            warnings: [],
            rows: rules.map((row) => ({
                model_id: row.model_id,
                model_name: row.upstream_model,
                tier: 'enterprise',
                group: 'GPT-Pro20x',
                before: null,
                after: { input_cny_per_1m: 0.8, output_cny_per_1m: 4.8, per_image_cny: null },
            })),
            customer_overrides: [],
        },
    };
}
afterEach(() => vi.unstubAllGlobals());

describe('group pricing drafts', () => {
    it('shows clean saved cache prices and preserves them exactly in a full-group preview payload', () => {
        const changed = {
            ...catalog,
            models: [
                {
                    ...model,
                    config: { ...config, token_rates: { ...config.token_rates, cache_read: 0.39999999999999997 } },
                },
            ],
        };
        const drafts = groupInitialDrafts(changed);
        expect(drafts[model.id].token_rates.cache_read).toBe('0.4');
        const html = renderToStaticMarkup(
            <GroupModelQuote
                model={changed.models[0]}
                draft={drafts[model.id]}
                settings={settings}
                isDark={false}
                en={false}
                disabled={false}
                onChange={() => {}}
            />,
        );
        expect(html).toContain('value="0.4"');
        expect(html).not.toContain('0.39999999999999997');
        const payload = groupPreviewInput(changed, drafts, settings)!;
        expect(payload.models[0].config.token_rates.cache_read).toBe(0.39999999999999997);
        expect(payload.models[0].config).not.toHaveProperty('number_sources');
        expect(calculateCostPricing(payload.models[0].config).lines).toEqual(
            calculateCostPricing(changed.models[0].config).lines,
        );
    });
    it('creates one full-group payload and applies shared settings once to every base quote', () => {
        const input = groupPreviewInput(catalog, groupInitialDrafts(catalog), settings)!;
        expect(input.models).toHaveLength(2);
        expect(input.group_id).toBe('group-1');
        expect(input.catalog_fingerprint).toBe('before-save');
        expect(input.models.map((row) => row.expected_revision)).toEqual([2, 3]);
        expect(input.models.map((row) => calculateCostPricing(row.config).lines.map((line) => line.retail))).toEqual([
            [0.8, 4.8, 0.08],
            [0.64, 3.2, 0.064, 0.8],
        ]);
    });
    it('loads a missing base rate as an empty editable field instead of throwing or reusing the previous group', () => {
        const incomplete = {
            ...catalog,
            models: [{ ...model, config: { ...config, token_rates: { ...config.token_rates, input: null } } }],
        };
        const drafts = groupInitialDrafts(incomplete);
        expect(drafts[model.id].token_rates.input).toBe('');
        expect(groupPreviewInput(incomplete, drafts, settings)).toBeNull();
        drafts[model.id].token_rates.input = '5';
        expect(groupPreviewInput(incomplete, drafts, settings)?.models).toHaveLength(1);
    });
    it('keeps different model base prices while replacing older individual multipliers', () => {
        const drafts = groupInitialDrafts(catalog);
        drafts['row-1'].retail_multiplier = '2.5';
        drafts['row-2'].upstream_multiplier = '9';
        const input = groupPreviewInput(catalog, drafts, settings)!;
        expect(input.models.map((row) => row.config.retail_multiplier)).toEqual([1.6, 1.6]);
        expect(input.models.map((row) => row.config.upstream_multiplier)).toEqual([1.3, 1.3]);
        expect(input.models.map((row) => row.config.token_rates.input)).toEqual([5, 4]);
    });
    it('never silently omits an unregistered or unsupported live model', () => {
        for (const broken of [
            { model_id: null, selectable: false },
            { selectable: false, status: 'unsupported' as const },
        ]) {
            const changed = { ...catalog, models: [model, { ...catalog.models[1], ...broken }] };
            expect(groupPreviewInput(changed, groupInitialDrafts(changed), settings)).toBeNull();
        }
    });
    it('blocks the whole group when a required quote or cache rate is absent and allows correction', () => {
        const drafts = groupInitialDrafts(catalog);
        drafts['row-1'].token_rates.cache_read = '';
        expect(groupPreviewInput(catalog, drafts, settings)).toBeNull();
        expect(groupModelIssue(model, drafts['row-1'], settings)).toContain('缓存');
        drafts['row-1'].token_rates.cache_read = '0';
        expect(groupPreviewInput(catalog, drafts, settings)?.models[0].config.token_rates.cache_read).toBe(0);
        drafts['row-1'].token_rates.input = '';
        expect(groupPreviewInput(catalog, drafts, settings)).toBeNull();
    });
    it('rejects empty, duplicate and oversized model collections rather than splitting publication', () => {
        expect(groupPreviewInput({ ...catalog, models: [] }, {}, settings)).toBeNull();
        expect(
            groupPreviewInput({ ...catalog, models: [model, model] }, groupInitialDrafts(catalog), settings),
        ).toBeNull();
        const large = {
            ...catalog,
            models: Array.from({ length: 31 }, (_, index) => ({ ...model, id: `r-${index}`, model_id: `m-${index}` })),
        };
        expect(groupPreviewInput(large, groupInitialDrafts(large), settings)).toBeNull();
    });
    it('prefills only shared saved settings, never claims reference defaults are operator settings', () => {
        expect(groupInitialSettings(catalog)).toEqual(settings);
        const conflicting = {
            ...catalog,
            models: [model, { ...catalog.models[1], config: { ...config, upstream_multiplier: 1.5 } }],
        };
        expect(groupInitialSettings(conflicting).upstream_multiplier).toBe('');
        expect(
            groupInitialSettings({
                ...catalog,
                models: catalog.models.map((row) => ({ ...row, base_source: 'reference' as const })),
            }),
        ).toEqual({ currency: 'credits', credits_per_cny: '', upstream_multiplier: '', retail_multiplier: '' });
    });
    it('rejects invalid shared multipliers and does not divide CNY twice', () => {
        expect(groupSettingsValue({ ...settings, retail_multiplier: '1.2' })).toBeNull();
        expect(groupSettingsValue({ ...settings, credits_per_cny: '' })).toBeNull();
        expect(groupSettingsValue({ ...settings, upstream_multiplier: 'Infinity' })).toBeNull();
        expect(groupSettingsValue({ ...settings, currency: 'cny' })!.credits_per_cny).toBe(1);
    });
    it('keeps image quantities separate from token rates', () => {
        const imageConfig: PricingCostConfig = {
            ...config,
            basis: 'image',
            token_rates: { input: null, output: null, cache_read: null, cache_write: null },
            variants: [
                {
                    key: '4k',
                    label: '4K',
                    resolution: '4k',
                    audio: 'any',
                    reference_video: 'any',
                    price: 10,
                    minimum_units: 1,
                    step_units: 1,
                },
            ],
        };
        const imageModel: PricingGroupModel = {
            ...model,
            config: imageConfig,
            capability: { ...model.capability!, basis: 'image', required_token_rates: undefined },
        };
        const imageCatalog = { ...catalog, models: [imageModel] };
        const input = groupPreviewInput(imageCatalog, groupInitialDrafts(imageCatalog), settings)!;
        expect(input.models[0].variant_key).toBe('4k');
        expect(calculateCostPricing(input.models[0].config).lines[0]).toMatchObject({ unit: 'image', retail: 1.6 });
    });
    it.each(['1k', '2k', '4k', null])(
        'allows a missing %s image quote to be filled and published by image',
        (resolution) => {
            const imageModel: PricingGroupModel = {
                ...model,
                display_name: 'Image model',
                status: 'missing_price',
                ready: false,
                base_source: 'manual',
                saved_revision: null,
                saved_rule_id: null,
                config: {
                    ...config,
                    basis: 'image',
                    token_rates: { input: null, output: null, cache_read: null, cache_write: null },
                    variants: [],
                },
                capability: {
                    model_id: model.model_id!,
                    tier: 'enterprise',
                    basis: 'image',
                    resolution,
                    publishable: true,
                    reason: null,
                },
            };
            const imageCatalog = { ...catalog, models: [imageModel] };
            const drafts = groupInitialDrafts(imageCatalog);
            const key = resolution ?? 'standard';
            expect(drafts[model.id].variants).toEqual([
                {
                    key,
                    label: resolution ? resolution.toUpperCase() : '标准',
                    resolution: key,
                    audio: 'any',
                    reference_video: 'any',
                    price: '',
                    minimum_units: '1',
                    step_units: '1',
                },
            ]);
            expect(groupPreviewInput(imageCatalog, drafts, settings)).toBeNull();
            const html = renderToStaticMarkup(
                <GroupModelQuote
                    model={imageModel}
                    draft={drafts[model.id]}
                    settings={settings}
                    isDark={false}
                    en={false}
                    disabled={false}
                    onChange={() => {}}
                />,
            );
            expect(html).toContain(`aria-label="Image model ${resolution ? resolution.toUpperCase() : '标准'}"`);
            expect(html).toContain('value=""');
            drafts[model.id].variants[0].price = '10';
            const input = groupPreviewInput(imageCatalog, drafts, settings)!;
            expect(input.models).toHaveLength(1);
            expect(input.models[0]).toMatchObject({
                variant_key: key,
                config: {
                    basis: 'image',
                    variants: [{ key, resolution: key, price: 10, minimum_units: 1, step_units: 1 }],
                },
            });
            expect(calculateCostPricing(input.models[0].config).lines).toEqual([
                expect.objectContaining({ unit: 'image', cost: 1.3, retail: 1.6 }),
            ]);
        },
    );
    it('does not invent an image variant for a model that cannot be published', () => {
        const unsupported = {
            ...catalog,
            models: [{ ...model, selectable: false, config: { ...config, basis: 'image' as const, variants: [] } }],
        };
        expect(groupInitialDrafts(unsupported)[model.id].variants).toEqual([]);
    });
});

describe('group pricing request lifecycle', () => {
    it('saves and previews all models in one request and confirms the returned revision in one request', async () => {
        const data = responseData();
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(Response.json(data))
            .mockResolvedValueOnce(Response.json({ job: { id: 'one-job', status: 'queued' } }, { status: 202 }));
        vi.stubGlobal('fetch', fetch);
        const input = groupPreviewInput(catalog, groupInitialDrafts(catalog), settings)!;
        const prepared = await requestGroupPricingPreview(input);
        expect(prepared.catalog_fingerprint).toBe('after-save');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetch.mock.calls[0][1].body).models).toHaveLength(2);
        expect(await publishGroupPricing(prepared)).toMatchObject({ id: 'one-job' });
        expect(fetch).toHaveBeenCalledTimes(2);
        const body = JSON.parse(fetch.mock.calls[1][1].body);
        expect(body).toMatchObject({
            action: 'publish',
            group_id: 'group-1',
            catalog_fingerprint: 'after-save',
            preview_token: 'signed-preview',
            selection_token: 'signed-selection',
        });
        expect(body.selections).toEqual([
            { rule_id: 'rule-1', revision: 3 },
            { rule_id: 'rule-2', revision: 4 },
        ]);
    });
    it('retains saved revisions if the subsequent preview fails', async () => {
        const saved = {
            rules: savedRules(),
            catalog_fingerprint: 'saved-but-not-previewed',
            message: 'new-api unavailable',
        };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(saved, { status: 502 })));
        const input = groupPreviewInput(catalog, groupInitialDrafts(catalog), settings)!;
        await expect(requestGroupPricingPreview(input)).rejects.toMatchObject({ saved });
    });
    it('rejects a partial server response without losing returned draft versions', async () => {
        const data = responseData();
        data.selections.pop();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(data)));
        const input = groupPreviewInput(catalog, groupInitialDrafts(catalog), settings)!;
        await expect(requestGroupPricingPreview(input)).rejects.toBeInstanceOf(GroupPricingRequestError);
    });
    it('never submits an expired preview', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const prepared = {
            ...responseData(),
            group_id: 'group-1',
            preview: { ...responseData().preview, expires_at: '2000-01-01T00:00:00Z' },
        } as GroupPricingPrepared;
        await expect(publishGroupPricing(prepared)).rejects.toThrow('过期');
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('group pricing presentation', () => {
    it('starts with tier selection instead of model selection', () => {
        const html = renderToStaticMarkup(
            <GroupPricingWorkbench isDark={false} locale="zh" onPublished={() => {}} onUncertain={() => {}} />,
        );
        expect(html).toContain('按档次统一定价');
        expect(html).toContain('pricing-group-select');
        expect(html).not.toContain('请选择模型');
    });
    it('shows exact token prices and distinct cache write price with editable base quotes', () => {
        const row = catalog.models[1];
        const html = renderToStaticMarkup(
            <GroupModelQuote
                model={row}
                draft={groupInitialDrafts(catalog)[row.id]}
                settings={settings}
                isDark={false}
                en={false}
                disabled={false}
                onChange={() => {}}
            />,
        );
        for (const value of ['¥0.64', '¥3.2', '¥0.064', '¥0.8']) expect(html).toContain(value);
        expect(html).toContain('缓存写入');
        expect(html).toContain('修改基础报价');
    });
    it('supports the simple group flow with read-only supplier quotes', () => {
        const row = catalog.models[1];
        const html = renderToStaticMarkup(
            <GroupModelQuote
                model={row}
                draft={groupInitialDrafts(catalog)[row.id]}
                settings={settings}
                isDark={false}
                en={false}
                disabled={false}
                allowQuoteEditing={false}
                onChange={() => {}}
            />,
        );
        expect(html).toContain('缓存写入');
        expect(html).not.toContain('修改基础报价');
        expect(html).not.toContain('<input');
    });
    it('renders missing prices as an issue, preserving explicit zero cache prices', () => {
        const drafts = groupInitialDrafts(catalog);
        drafts[model.id].token_rates.cache_read = '0';
        expect(groupModelConfig(model, drafts[model.id], settings)?.token_rates.cache_read).toBe(0);
        const broken = { ...model, model_id: null, selectable: false, config: null, reason: '未登记到 Portal' };
        const html = renderToStaticMarkup(
            <GroupModelQuote
                model={broken}
                settings={settings}
                isDark={false}
                en={false}
                disabled={false}
                onChange={() => {}}
            />,
        );
        expect(html).toContain('待处理');
        expect(html).toContain('未登记到 Portal');
        expect(html).not.toContain('¥0');
    });
    it('shows each model in the final price review without old input-length comparisons', () => {
        const preview = responseData().preview;
        const html = renderToStaticMarkup(<GroupPricingPreview preview={preview} en={false} isDark={false} />);
        expect(html).toContain('gpt-5.5');
        expect(html).toContain('gpt-5.6-sol');
        expect(html).not.toContain('272');
        expect(html).not.toContain('当前价格对比');
    });
});

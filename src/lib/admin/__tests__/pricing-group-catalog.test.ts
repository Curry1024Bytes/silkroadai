import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminPrincipal } from '../auth';
import type { PublishSource, PublishState } from '../pricing-publish-plan';
import type { PricingCostConfig, StoredPricingCostRule } from '../pricing-cost-types';
import type { OfficialPriceCatalog } from '../litellm-official-prices';

const mocks = vi.hoisted(() => ({
    state: vi.fn(),
    source: vi.fn(),
    rules: vi.fn(),
    references: vi.fn(),
    groups: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: { channelGroup: { findMany: mocks.groups } } }));
vi.mock('../pricing-publish', () => ({ readPublishState: mocks.state, readPublishSource: mocks.source }));
vi.mock('../pricing-cost-store', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    listCostRules: mocks.rules,
}));
vi.mock('../litellm-official-prices', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    getLiteLlmPriceCatalog: mocks.references,
}));
vi.mock('@/lib/newapi/quota-units', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    QUOTA_PER_USD: 500_000,
    USD_TO_CNY_RATE: 1,
    quotaToCny: (quota: number) => quota / 500_000,
}));

import {
    buildPricingGroupCatalog,
    discoverPricingGroupCatalog,
    exactGroupReference,
    listPricingGroups,
} from '../pricing-group-catalog';
import { calculateCostPricing } from '../pricing-cost';

const ADMIN: AdminPrincipal = { role: 'admin', tenant_id: 'tenant-a', user: null, viaBreakGlass: false };
const NOW = '2026-09-18T01:00:00.000Z';
let state: PublishState;
let source: PublishSource;
let references: OfficialPriceCatalog;
let rules: StoredPricingCostRule[];
const config = (): PricingCostConfig => ({
    version: 1,
    basis: 'token',
    currency: 'credits',
    credits_per_cny: 10,
    upstream_multiplier: 1.3,
    retail_multiplier: 1.6,
    markup_percent: 0,
    source_note: 'Confirmed supplier quote',
    token_rates: { input: 5, output: 30, cache_read: 0.5, cache_write: null },
    variants: [],
});
function catalog() {
    return buildPricingGroupCatalog({ admin: ADMIN, groupId: 'group-a', state, source, rules, references });
}
function savedRule(): StoredPricingCostRule {
    return {
        id: 'rule-a',
        model_id: 'model-a',
        tier: 'enterprise',
        channel_id: 5,
        upstream_model: 'gpt-5.5',
        revision: 2,
        config: config(),
        updated_at: NOW,
        mapping_current: true,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    state = {
        models: [
            {
                id: 'model-a',
                tenant_id: 'tenant-a',
                slug: 'gpt-5.5',
                display_name: 'GPT 5.5',
                modality: 'text',
                enabled: true,
                upstream_map: { enterprise: { channel_id: 5, upstream_model: 'gpt-5.5' } },
                updated_at: NOW,
            },
        ],
        groups: [
            {
                id: 'group-a',
                tenant_id: 'tenant-a',
                key: 'enterprise',
                display_name: '企业档',
                newapi_group: 'Enterprise',
                enabled: true,
                is_default: true,
                tier_level: 0,
                newapi_channel_ids: [5],
                updated_at: NOW,
            },
        ],
        prices: [],
    };
    source = {
        channels: [{ id: 5, name: 'Channel A', status: 1, groups: ['Enterprise'], models: ['gpt-5.5'] }],
        options: {
            ModelRatio: { 'gpt-5.5': 2.5 },
            CompletionRatio: { 'gpt-5.5': 6 },
            ModelPrice: {},
            GroupRatio: { Enterprise: 0.16 },
            GroupGroupRatio: {},
            QuotaPerUnit: 500_000,
            CompletionRatioMeta: { 'gpt-5.5': { ratio: 6, locked: false } },
            'billing_setting.billing_mode': {},
            'billing_setting.billing_expr': {},
        },
    };
    references = {
        source: 'litellm-cdn',
        sourceLabel: 'LiteLLM CDN',
        fetchedAt: NOW,
        models: [
            {
                model: 'gpt-5.5',
                provider: 'openai',
                inputUsdPer1m: 5,
                outputUsdPer1m: 30,
                cacheReadUsdPer1m: 0.5,
                cacheWrite5mUsdPer1m: null,
                cacheWrite1hUsdPer1m: null,
            },
        ],
    };
    rules = [];
    mocks.state.mockImplementation(async () => state);
    mocks.source.mockImplementation(async () => source);
    mocks.rules.mockImplementation(async () => rules);
    mocks.references.mockImplementation(async () => references);
});

describe('group pricing model discovery', () => {
    it('finds a registered live model and uses an exact reference without changing the source', () => {
        const before = structuredClone({ state, source });
        const result = catalog();
        expect(result.tier).toEqual({ id: 'group-a', key: 'enterprise', label: '企业档', newapi_group: 'Enterprise' });
        expect(result.counts).toEqual({ total: 1, ready: 1, needs_price: 0, unavailable: 0 });
        expect(result.models[0]).toMatchObject({
            ready: true,
            selectable: true,
            base_source: 'reference',
            model_id: 'model-a',
            channel_ids: [5],
        });
        expect(result.models[0].config?.token_rates).toEqual({
            input: 5,
            output: 30,
            cache_read: 0.5,
            cache_write: null,
        });
        expect({ state, source }).toEqual(before);
    });

    it('deduplicates models across registered live channels and ignores other groups or stopped channels', () => {
        state.groups[0].newapi_channel_ids.push(6);
        source.channels.push(
            { id: 6, name: 'B', status: 1, groups: ['Enterprise'], models: ['gpt-5.5', 'gpt-5.5'] },
            { id: 7, name: 'Other', status: 1, groups: ['enterprise'], models: ['secret-model'] },
            { id: 8, name: 'Stopped', status: 2, groups: ['Enterprise'], models: ['stopped-model'] },
        );
        expect(catalog().models).toHaveLength(1);
        expect(catalog().models[0].channel_ids).toEqual([5, 6]);
    });

    it('reports every new-api model that has no Portal association instead of silently skipping it', () => {
        source.channels[0].models.push('unknown-model');
        const result = catalog();
        expect(result.counts).toMatchObject({ total: 2, unavailable: 1 });
        expect(result.models.find((row) => row.upstream_model === 'unknown-model')).toMatchObject({
            model_id: null,
            status: 'unregistered',
            selectable: false,
            config: null,
        });
    });

    it('blocks a live group channel that was not registered even when another channel maps correctly', () => {
        source.channels.push({ id: 99, name: 'Undeclared', status: 1, groups: ['Enterprise'], models: ['gpt-5.5'] });
        expect(catalog().models[0]).toMatchObject({
            status: 'unregistered_channel',
            ready: false,
            selectable: false,
            channel_ids: [5, 99],
        });
    });

    it('excludes removed upstream models from group coverage and reports stale Portal mappings separately', () => {
        source.channels[0].models = [];
        expect(catalog().models).toEqual([]);
        expect(catalog().counts.total).toBe(0);
        expect(catalog().notices).toEqual([expect.stringContaining('1 个旧模型关联')]);
        source.channels[0].models = ['gpt-5.5'];
        state.models[0].enabled = false;
        expect(catalog().models[0]).toMatchObject({ status: 'inactive', channel_ids: [5] });
    });

    it('rejects an exact model whose mapped channel is stopped instead of rerouting it', () => {
        source.channels[0].status = 2;
        state.groups[0].newapi_channel_ids.push(6);
        source.channels.push({ id: 6, name: 'B', status: 1, groups: ['Enterprise'], models: ['gpt-5.5'] });
        expect(catalog().models[0]).toMatchObject({ status: 'invalid_mapping', selectable: false });
    });

    it('does not collapse two active Portal models sharing an upstream price into one selected row', () => {
        state.models.push({ ...state.models[0], id: 'model-b', slug: 'alias' });
        expect(catalog().models[0]).toMatchObject({ status: 'ambiguous', model_id: null, selectable: false });
    });

    it('refuses a cross-tenant group ID or a disabled group', () => {
        state.groups[0].tenant_id = 'tenant-b';
        expect(() => catalog()).toThrow('档次不存在');
        state.groups[0].tenant_id = 'tenant-a';
        state.groups[0].enabled = false;
        expect(() => catalog()).toThrow('已停用');
    });

    it('never binds a same-key model from another tenant', () => {
        state.models[0].tenant_id = 'tenant-b';
        expect(catalog().models[0]).toMatchObject({ status: 'unregistered', model_id: null });
    });

    it('prefers a current saved quote and preserves its revision and exact 1:10 arithmetic', () => {
        rules = [savedRule()];
        references.models[0].inputUsdPer1m = 999;
        const row = catalog().models[0];
        expect(row).toMatchObject({ base_source: 'saved', saved_revision: 2, saved_rule_id: 'rule-a', ready: true });
        expect(row.config).toEqual(config());
        expect(calculateCostPricing(row.config!).lines.map((line) => [line.cost, line.retail])).toEqual([
            [0.65, 0.8],
            [3.9, 4.8],
            [0.065, 0.08],
        ]);
    });

    it('does not apply an old quote to a replacement channel, but preserves revision for safe edits', () => {
        rules = [{ ...savedRule(), channel_id: 99, mapping_current: false }];
        expect(catalog().models[0]).toMatchObject({
            base_source: 'reference',
            saved_revision: 2,
            saved_rule_id: 'rule-a',
        });
    });

    it('offers manual entry for missing quotes and does not guess from partial or provider-prefixed names', () => {
        references.models[0].model = 'openai/gpt-5.5';
        const row = catalog().models[0];
        expect(row).toMatchObject({ status: 'missing_price', selectable: true, ready: false, base_source: 'manual' });
        expect(row.config?.token_rates).toEqual({ input: null, output: null, cache_read: null, cache_write: null });
        expect(exactGroupReference(references.models, 'gpt')).toBeNull();
    });

    it('keeps absent cache prices null, explicit zero zero, and removes floating point display noise', () => {
        references.models[0].cacheReadUsdPer1m = null;
        references.models[0].cacheWrite5mUsdPer1m = 0;
        expect(catalog().models[0].config?.token_rates).toMatchObject({ cache_read: null, cache_write: 0 });
        references.models[0].cacheReadUsdPer1m = 0.39999999999999997;
        expect(catalog().models[0].config?.token_rates.cache_read).toBe(0.4);
    });

    it('preserves explicit one-hour cache rates without inventing a value when omitted', () => {
        references.models[0].cacheWrite1hUsdPer1m = 10;
        expect(catalog().models[0].config?.token_rates.cache_write_1h).toBe(10);
        references.models[0].cacheWrite1hUsdPer1m = null;
        expect(catalog().models[0].config?.token_rates).not.toHaveProperty('cache_write_1h');
    });

    it('requires every live cached-token category before marking an expression-priced model ready', () => {
        source.options['billing_setting.billing_mode'] = { 'gpt-5.5': 'tiered_expr' };
        source.options['billing_setting.billing_expr'] = {
            'gpt-5.5': 'tier("base", p * 5 + c * 30 + cr * 0.5 + cc * 6.25)',
        };
        let row = catalog().models[0];
        expect(row).toMatchObject({ status: 'missing_price', selectable: true, ready: false });
        expect(row.capability?.required_token_rates).toEqual(['cache_read', 'cache_write']);
        references.models[0].cacheWrite5mUsdPer1m = 6.25;
        row = catalog().models[0];
        expect(row).toMatchObject({ status: 'ready', selectable: true, ready: true });
    });

    it('does not use a token reference for an image model; missing per-image quote is editable', () => {
        state.models[0].modality = 'image';
        source.options.ModelPrice = { 'gpt-5.5': 2 };
        const row = catalog().models[0];
        expect(row).toMatchObject({ status: 'missing_price', selectable: true, ready: false, base_source: 'manual' });
        expect(row.config).toMatchObject({ basis: 'image', variants: [], token_rates: { input: null } });
    });

    it('uses saved per-image variants and explicitly blocks unsupported video publication', () => {
        state.models[0].modality = 'image';
        source.options.ModelPrice = { 'gpt-5.5': 2 };
        const imageConfig: PricingCostConfig = {
            ...config(),
            basis: 'image',
            token_rates: { input: null, output: null, cache_read: null, cache_write: null },
            variants: [
                {
                    key: 'standard',
                    label: '标准',
                    resolution: 'standard',
                    audio: 'any',
                    reference_video: 'any',
                    price: 2,
                    minimum_units: 1,
                    step_units: 1,
                },
            ],
        };
        rules = [{ ...savedRule(), config: imageConfig }];
        expect(catalog().models[0]).toMatchObject({ ready: true, base_source: 'saved', config: imageConfig });
        state.models[0].modality = 'video';
        expect(catalog().models[0]).toMatchObject({ status: 'unsupported', selectable: false, ready: false });
        expect(catalog().models[0].reason).toContain('视频');
    });

    it('changes its guard for channels, references, saved revisions, and live prices', () => {
        const first = catalog().fingerprint;
        references.models[0].inputUsdPer1m = 6;
        expect(catalog().fingerprint).not.toBe(first);
        references.models[0].inputUsdPer1m = 5;
        expect(catalog().fingerprint).toBe(first);
        references.fetchedAt = '2026-09-18T02:00:00.000Z';
        expect(catalog().fingerprint).toBe(first);
        source.options.GroupRatio = { Enterprise: 0.2 };
        expect(catalog().fingerprint).not.toBe(first);
    });

    it('lists tiers with server-side tenant scope and no new-api calls', async () => {
        mocks.groups.mockResolvedValue(state.groups);
        expect(await listPricingGroups(ADMIN)).toEqual([catalog().tier]);
        expect(mocks.groups).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenant_id: 'tenant-a', enabled: true } }),
        );
        expect(mocks.source).not.toHaveBeenCalled();
    });

    it('keeps saved costs available after reference fetch failure but does not hide new-api errors', async () => {
        rules = [savedRule()];
        mocks.references.mockRejectedValue(new Error('reference offline'));
        const result = await discoverPricingGroupCatalog(ADMIN, 'group-a');
        expect(result.reference_error).toContain('无法获取');
        expect(result.models[0]).toMatchObject({ ready: true, base_source: 'saved' });
        mocks.source.mockRejectedValue(new Error('new-api offline'));
        await expect(discoverPricingGroupCatalog(ADMIN, 'group-a')).rejects.toThrow('new-api offline');
    });
});

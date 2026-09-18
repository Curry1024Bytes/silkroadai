import { describe, expect, it } from 'vitest';
import type { PricingCostConfig } from '../pricing-cost-types';
import type { PricingGroupCatalog } from '../pricing-group-types';
import {
    assertGroupCoverage,
    assertGroupSavedSelection,
    groupScopeFromCatalog,
    prepareGroupCostDrafts,
    pricingGroupSettingsSchema,
} from '../pricing-group-workflow';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const config = (): PricingCostConfig => ({
    version: 1,
    basis: 'token',
    currency: 'credits',
    credits_per_cny: 10,
    upstream_multiplier: 1.3,
    retail_multiplier: 1.6,
    markup_percent: 0,
    source_note: '',
    token_rates: { input: 5, output: 30, cache_read: 0.5, cache_write: null },
    variants: [],
});
const settings = () => ({
    currency: 'credits' as const,
    credits_per_cny: 10,
    upstream_multiplier: 1.3,
    retail_multiplier: 1.6,
});
const catalog = (): PricingGroupCatalog => ({
    tier: { id: A, key: 'enterprise', label: '企业级', newapi_group: 'GPT' },
    fingerprint: 'a'.repeat(64),
    reference_error: null,
    notices: [],
    counts: { total: 2, ready: 2, needs_price: 0, unavailable: 0 },
    models: [A, B].map((id) => ({
        id,
        model_id: id,
        slug: id,
        display_name: id,
        upstream_model: id,
        channel_ids: [5],
        status: 'ready',
        selectable: true,
        ready: true,
        config: config(),
        saved_revision: 1,
        saved_rule_id: id,
        capability: {
            model_id: id,
            tier: 'enterprise',
            basis: 'token',
            resolution: null,
            publishable: true,
            reason: null,
        },
        reason: null,
        base_source: 'saved',
        reference_model: null,
    })),
});
const drafts = () => [A, B].map((id) => ({ model_id: id, expected_revision: 1, config: config() }));
describe('whole group cost workflow', () => {
    it('normalizes all drafts to the one explicit setting while preserving each base quote', () => {
        const rows = drafts();
        rows[1].config.token_rates.input = 4;
        rows[1].config.upstream_multiplier = 1;
        rows[1].config.retail_multiplier = 2;
        const result = prepareGroupCostDrafts(catalog(), 'a'.repeat(64), settings(), rows);
        expect(result.map((r) => r.config.token_rates.input)).toEqual([5, 4]);
        expect(
            result.every(
                (r) =>
                    r.tier === 'enterprise' &&
                    r.config.upstream_multiplier === 1.3 &&
                    r.config.retail_multiplier === 1.6,
            ),
        ).toBe(true);
        expect(result[0].config.token_rates.cache_write).toBeNull();
    });
    it('refuses partial, repeated and foreign rows rather than changing unselected prices', () => {
        for (const ids of [[A], [A, A], [A, 'foreign']]) expect(() => assertGroupCoverage(catalog(), ids)).toThrow();
    });
    it('fails the whole group if even one live model is unregistered', () => {
        const c = catalog();
        c.models[1].model_id = null;
        c.models[1].selectable = false;
        expect(() => assertGroupCoverage(c, [A, B])).toThrow(/还有 1 个模型/);
    });
    it('allows a valid manually completed quote for a missing-price model', () => {
        const c = catalog();
        c.models[1].ready = false;
        c.models[1].status = 'missing_price';
        expect(prepareGroupCostDrafts(c, c.fingerprint, settings(), drafts())).toHaveLength(2);
    });
    it('refuses empty or oversized groups without silently chunking a shared multiplier', () => {
        const c = catalog();
        c.models = [];
        expect(() => assertGroupCoverage(c, [])).toThrow(/没有可用模型/);
        c.models = Array.from({ length: 31 }, () => catalog().models[0]);
        expect(() => assertGroupCoverage(c, [])).toThrow(/30/);
    });
    it('rejects stale discovery and stale saved cost revisions', () => {
        expect(() => prepareGroupCostDrafts(catalog(), 'b'.repeat(64), settings(), drafts())).toThrow(/已变化/);
        const rows = drafts();
        rows[1].expected_revision = 2;
        expect(() => prepareGroupCostDrafts(catalog(), 'a'.repeat(64), settings(), rows)).toThrow(/被更新/);
    });
    it('rejects changing a token model into image pricing', () => {
        const rows = drafts();
        rows[0].config = {
            ...config(),
            basis: 'image',
            token_rates: { input: null, output: null, cache_read: null, cache_write: null },
            variants: [
                {
                    key: 'standard',
                    label: '每张',
                    resolution: 'standard',
                    audio: 'any',
                    reference_video: 'any',
                    price: 1,
                    minimum_units: 1,
                    step_units: 1,
                },
            ],
        };
        expect(() => prepareGroupCostDrafts(catalog(), 'a'.repeat(64), settings(), rows)).toThrow(/计量单位/);
    });
    it('derives exact 0.16 group multiplier once, not 1.6 or 0.016', () => {
        expect(groupScopeFromCatalog(catalog())).toEqual({
            tier: 'enterprise',
            newapi_group: 'GPT',
            retail_ratio: 0.16,
        });
    });
    it('rejects incompatible saved common settings and legacy markup-only rules', () => {
        const c = catalog();
        c.models[1].config!.credits_per_cny = 5;
        expect(() => groupScopeFromCatalog(c)).toThrow(/不一致/);
        const legacy = catalog();
        delete legacy.models[0].config!.retail_multiplier;
        expect(() => groupScopeFromCatalog(legacy)).toThrow(/先填写/);
    });
    it('binds saved selections to this group and current revision', () => {
        assertGroupSavedSelection(catalog(), [
            { rule_id: A, revision: 1 },
            { rule_id: B, revision: 1 },
        ]);
        expect(() =>
            assertGroupSavedSelection(catalog(), [
                { rule_id: A, revision: 2 },
                { rule_id: B, revision: 1 },
            ]),
        ).toThrow();
        expect(() => assertGroupSavedSelection(catalog(), [{ rule_id: A, revision: 1 }])).toThrow();
    });
    it('refuses ambiguous CNY conversion or a sale multiplier below cost', () => {
        expect(pricingGroupSettingsSchema.safeParse({ ...settings(), currency: 'cny' }).success).toBe(false);
        expect(pricingGroupSettingsSchema.safeParse({ ...settings(), retail_multiplier: 1.2 }).success).toBe(false);
        expect(
            pricingGroupSettingsSchema.safeParse({ ...settings(), currency: 'cny', credits_per_cny: 1 }).success,
        ).toBe(true);
    });
});

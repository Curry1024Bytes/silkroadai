import { describe, expect, it } from 'vitest';
import type { OfficialContext } from '../context';
import type { OfficialCustomerRule, OfficialModelContext, OfficialPricingDraft } from '../types';
import { compileCustomerPreview } from '../preview';

const groupRule: OfficialCustomerRule = {
    id: 'group-rule',
    tier_key: 'sd',
    model_id: null,
    official_multiplier: 0.2,
    revision: 1,
};
const modelRule: OfficialCustomerRule = {
    id: 'model-rule',
    tier_key: 'sd',
    model_id: 'model-a',
    official_multiplier: 0.15,
    revision: 1,
};

function model(id = 'model-a', multiplier = 0.3): OfficialModelContext {
    return {
        model_id: id,
        model_name: id,
        display_name: id,
        tier_key: 'sd',
        public_group: 'SD官转',
        public_ratio: 1,
        source_channel_ids: [13],
        reference_revision: 'reference:1',
        reference_source: '已核对官方价',
        reference_available: true,
        unavailable_reason: null,
        shape: 'token',
        cells: [
            {
                key: 'input',
                label: '输入',
                unit: 'million_tokens',
                official_cny: 100,
                public_cny: 100 * multiplier,
                base_cny: 100 * multiplier,
                cost_cny: 10,
            },
            {
                key: 'output',
                label: '输出',
                unit: 'million_tokens',
                official_cny: 200,
                public_cny: 200 * multiplier,
                base_cny: 200 * multiplier,
                cost_cny: 20,
            },
        ],
        public_official_multiplier: multiplier,
        current_official_multiplier: multiplier,
        current_ratio: 1,
        current_rule_scope: null,
    };
}

function context(models: OfficialModelContext[] = [model()], rules: OfficialCustomerRule[] = []): OfficialContext {
    return {
        version: 'context-v1',
        rules,
        tiers: [
            {
                key: 'sd',
                display_name: 'SD官转',
                public_group: 'SD官转',
                public_ratio: 1,
                legacy_multiplier: null,
                models,
                binding_status: null,
            },
        ],
        user: { id: 'customer-a', tenant_id: 'tenant-a', newapi_user_id: 7, newapi_access_token: 'test-only' },
        options: {},
        channels: [],
        bindings: [],
        registry: [],
        model_states: {},
    };
}

const draft = (patch: Partial<OfficialPricingDraft> = {}): OfficialPricingDraft => ({
    tier_key: 'sd',
    model_id: null,
    official_multiplier: 0.2,
    ...patch,
});

describe('customer official-price publication previews', () => {
    it('prices a customer group directly at official ×0.2, independent of the public 0.3 factor', () => {
        const { preview } = compileCustomerPreview(context(), draft(), 2);
        expect(preview.blocked).toEqual([]);
        expect(preview.cells[0].before_cny).toBe(30);
        expect(preview.cells[0].target_cny).toBe(20);
        expect(preview.cells[0].actual_cny).toBeCloseTo(20, 8);
        expect(preview.cells[0].actual_cny).not.toBe(6);
        expect(preview.cells[0].official_multiplier).toBe(0.2);
        expect(preview.cells[0].rule_scope).toBe('tier');
        expect(preview.affected_keys).toBe(2);
    });

    it('gives an explicit model rule priority over the customer group default and preserves other groups', () => {
        const unrelated = { ...groupRule, id: 'kiro-rule', tier_key: 'kiro', official_multiplier: 0.8 };
        const source = context([model(), model('model-b')], [groupRule, modelRule, unrelated]);
        const { preview, rules } = compileCustomerPreview(source, draft({ official_multiplier: 0.25 }), 1);
        const a = preview.cells.find((cell) => cell.model_id === 'model-a')!;
        const b = preview.cells.find((cell) => cell.model_id === 'model-b')!;
        expect(a.target_cny).toBe(15);
        expect(a.actual_cny).toBeCloseTo(15, 8);
        expect(a.rule_scope).toBe('model');
        expect(b.target_cny).toBe(25);
        expect(b.actual_cny).toBeCloseTo(25, 8);
        expect(b.rule_scope).toBe('tier');
        expect(rules.find((rule) => rule.tier_key === 'kiro')).toEqual(unrelated);
        expect(source.rules).toEqual([groupRule, modelRule, unrelated]);
    });

    it('falls back to the group official rule when a model override is deleted', () => {
        const source = context([model()], [groupRule, modelRule]);
        source.tiers[0].models[0].current_ratio = 0.5;
        const result = compileCustomerPreview(source, draft({ model_id: 'model-a', official_multiplier: null }), 1);
        expect(result.preview.cells[0].before_cny).toBe(15);
        expect(result.preview.cells[0].actual_cny).toBeCloseTo(20, 8);
        expect(result.preview.cells[0].official_multiplier).toBe(0.2);
        expect(result.preview.has_increases).toBe(true);
        expect(result.restoring).toBe(false);
    });

    it('removes the last rule and reports the restored public official factor, rather than the old factor', () => {
        const source = context([model()], [groupRule]);
        source.tiers[0].models[0].current_ratio = 2 / 3;
        source.tiers[0].models[0].current_official_multiplier = 0.2;
        const result = compileCustomerPreview(source, draft({ official_multiplier: null }), 1);
        expect(result.restoring).toBe(true);
        expect(result.preview.cells[0].actual_cny).toBe(30);
        expect(result.preview.cells[0].target_cny).toBe(30);
        expect(result.preview.cells[0].official_multiplier).toBe(0.3);
        expect(result.preview.cells[0].rule_scope).toBeNull();
    });

    it('keeps the legacy customer factor when the last new-style rule is removed', () => {
        const source = context([model()], [groupRule]);
        source.tiers[0].legacy_multiplier = 0.8;
        source.tiers[0].models[0].current_ratio = 2 / 3;
        source.tiers[0].models[0].current_official_multiplier = 0.2;

        const result = compileCustomerPreview(source, draft({ official_multiplier: null }), 1);

        expect(result.restoring).toBe(false);
        // Legacy multipliers are native group factors applied to the configured
        // base price (30 here), not official-price discounts.
        expect(result.preview.cells[0].actual_cny).toBe(24);
        expect(result.preview.cells[0].target_cny).toBe(24);
        expect(result.preview.cells[0].official_multiplier).toBeCloseTo(0.24, 10);
        expect(result.preview.cells[0].rule_scope).toBe('legacy');
        expect(result.preview.warnings.join(' ')).toContain('0.8');
    });

    it('retains legacy 0.8 as a public-price factor and accurately flags the old Pro loss', () => {
        const pro = model('model-a', 0.72);
        pro.cells[0].cost_cny = 65;
        pro.cells[1].cost_cny = 130;
        pro.current_ratio = 0.8;
        pro.current_official_multiplier = 0.576;
        const source = context([pro, model('model-b')]);
        source.tiers[0].legacy_multiplier = 0.8;
        const result = compileCustomerPreview(source, draft({ model_id: 'model-b' }), 1);
        const row = result.preview.cells.find((cell) => cell.model_id === 'model-a')!;
        expect(row.actual_cny).toBe(57.6);
        expect(row.official_multiplier).toBe(0.576);
        expect(row.rule_scope).toBe('legacy');
        expect(row.margin).toBeCloseTo((57.6 - 65) / 57.6, 10);
        expect(result.preview.below_cost).toBe(true);
        expect(result.preview.warnings.join(' ')).toContain('0.8');
    });

    it('detects a below-cost specification even if another specification is profitable', () => {
        const value = model();
        value.cells[1].cost_cny = 45;
        const { preview } = compileCustomerPreview(context([value]), draft(), 1);
        expect(preview.cells[0].margin).toBeCloseTo(0.5, 8);
        expect(preview.cells[1].margin).toBeCloseTo(-0.125, 8);
        expect(preview.below_cost).toBe(true);
    });

    it('keeps unverified purchasing costs unknown rather than reporting a profit', () => {
        const value = model();
        value.cells.forEach((cell) => {
            cell.cost_cny = null;
        });
        const { preview } = compileCustomerPreview(context([value]), draft(), 1);
        expect(preview.cells.every((cell) => cell.margin === null)).toBe(true);
        expect(preview.warnings.join(' ')).toContain('未知');
    });

    it('blocks a new rule without an official reference but allows removal to restore public pricing', () => {
        const value = {
            ...model(),
            reference_available: false,
            unavailable_reason: '缺少官方基准',
            current_official_multiplier: null,
        };
        expect(compileCustomerPreview(context([value]), draft(), 1).preview.blocked.join(' ')).toContain('官方基准');
        const removed = compileCustomerPreview(context([value], [groupRule]), draft({ official_multiplier: null }), 1);
        expect(removed.preview.blocked).toEqual([]);
        expect(removed.preview.cells[0].actual_cny).toBe(30);
        expect(removed.restoring).toBe(true);
    });

    it('blocks ambiguous shared models and nonproportional reference shapes', () => {
        const duplicate = { ...model('model-b'), model_name: 'model-a' };
        expect(compileCustomerPreview(context([model(), duplicate]), draft(), 1).preview.blocked.join(' ')).toContain(
            '共用',
        );
        const divergent = model();
        divergent.cells[1].base_cny = 61;
        expect(compileCustomerPreview(context([divergent]), draft(), 1).preview.blocked.join(' ')).toContain(
            '比例不一致',
        );
    });

    it('blocks incomplete bindings and missing source channels, instead of guessing a public fallback', () => {
        const source = context();
        source.tiers[0].binding_status = 'applying';
        expect(compileCustomerPreview(source, draft(), 1).preview.blocked.join(' ')).toContain('未核验');
        source.tiers[0].binding_status = null;
        source.tiers[0].models[0].source_channel_ids = [];
        expect(compileCustomerPreview(source, draft(), 1).preview.blocked.join(' ')).toContain('来源渠道');
    });

    it('rejects a model from another group and invalid multipliers', () => {
        expect(() => compileCustomerPreview(context(), draft({ model_id: 'wrong-group-model' }), 1)).toThrow('不属于');
        for (const multiplier of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 101])
            expect(() => compileCustomerPreview(context(), draft({ official_multiplier: multiplier }), 1)).toThrow(
                '倍率',
            );
    });

    it('changes the preview commitment when the quote or source snapshot changes', () => {
        const source = context();
        const first = compileCustomerPreview(source, draft(), 1).preview;
        const anotherPrice = compileCustomerPreview(source, draft({ official_multiplier: 0.21 }), 1).preview;
        const anotherVersion = compileCustomerPreview({ ...source, version: 'context-v2' }, draft(), 1).preview;
        expect(first.hash).not.toBe(anotherPrice.hash);
        expect(first.hash).not.toBe(anotherVersion.hash);
    });
});

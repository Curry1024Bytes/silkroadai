import { describe, expect, it } from 'vitest';
import { compileSaleRules, ruleProblems, type CompileInput, type SaleRuleInput } from '@/lib/pricing-rules/compile';

const NOW = new Date('2026-11-05T08:00:00Z');
const MINUTE = 60_000;

let seq = 0;
function rule(partial: Partial<SaleRuleInput> & Pick<SaleRuleInput, 'kind' | 'discount'>): SaleRuleInput {
    seq += 1;
    return {
        id: `r${seq}`,
        userId: null,
        tierKey: 'pool',
        modelId: null,
        effectiveFrom: null,
        effectiveTo: null,
        enabled: true,
        ...partial,
    };
}

function input(overrides: Partial<CompileInput> = {}): CompileInput {
    return {
        rules: [],
        groups: [{ tierKey: 'pool', newapiGroup: 'pool-gpt', unifiedSaleRatio: '1.2', servedModels: ['gpt-a'] }],
        catalog: [
            { id: 'm-a', upstreamByTier: { pool: 'gpt-a' } },
            { id: 'm-b', upstreamByTier: { pool: 'gpt-b' } },
        ],
        scheduledDiscountModels: [],
        managedRowUsers: {},
        excludedUserIds: [],
        now: NOW,
        leadMs: 2 * MINUTE,
        ...overrides,
    };
}

const twoModels = [
    { tierKey: 'pool', newapiGroup: 'pool-gpt', unifiedSaleRatio: '1.2', servedModels: ['gpt-a', 'gpt-b'] },
];

describe('compileSaleRules', () => {
    it('writes the unified ratio when no rule applies', () => {
        const out = compileSaleRules(input());
        expect(out.ownedGroups).toEqual(['pool-gpt']);
        expect(out.groupRatios).toEqual({ 'pool-gpt': 1.2 });
        expect(out.customerRows).toEqual({ 'pool-gpt': {} });
        expect(out.diagnostics).toEqual([]);
    });

    it('skips groups that are not managed', () => {
        const groups = [{ tierKey: 'pool', newapiGroup: 'pool-gpt', unifiedSaleRatio: null, servedModels: ['gpt-a'] }];
        const out = compileSaleRules(input({ groups, rules: [rule({ kind: 'global_tier', discount: '0.9' })] }));
        expect(out.ownedGroups).toEqual([]);
        expect(out.diagnostics.map((d) => d.code)).toEqual(['tier_unmanaged']);
    });

    it('applies a tier-wide global discount and rounds up to 6 decimals', () => {
        const out = compileSaleRules(
            input({ groups: twoModels, rules: [rule({ kind: 'global_tier', discount: '0.8333333' })] }),
        );
        expect(out.groupRatios['pool-gpt']).toBe(1);
    });

    it('writes a customer row for a customer-wide discount', () => {
        const out = compileSaleRules(
            input({ groups: twoModels, rules: [rule({ kind: 'customer_tier', userId: 'u1', discount: '0.8' })] }),
        );
        expect(out.customerRows['pool-gpt']).toEqual({ u1: 0.96 });
        expect(out.customers).toEqual([
            expect.objectContaining({
                userId: 'u1',
                ratio: 0.96,
                source: expect.objectContaining({ kind: 'customer_tier' }),
            }),
        ]);
    });

    it('lets a global discount win over a deeper customer-wide discount', () => {
        const rules = [
            rule({ kind: 'global_tier', discount: '0.9' }),
            rule({ kind: 'customer_tier', userId: 'u1', discount: '0.8' }),
        ];
        const out = compileSaleRules(input({ groups: twoModels, rules }));
        expect(out.groupRatios['pool-gpt']).toBe(1.08);
        expect(out.customerRows['pool-gpt']).toEqual({});
        expect(out.customers[0]).toMatchObject({ userId: 'u1', ratio: null, source: { kind: 'global_tier' } });
    });

    it('lets a customer-specific model discount win over the global discount', () => {
        const rules = [
            rule({ kind: 'global_tier', discount: '0.9' }),
            rule({ kind: 'customer_model', userId: 'u1', modelId: 'm-a', discount: '0.7' }),
        ];
        const out = compileSaleRules(input({ rules }));
        expect(out.customerRows['pool-gpt']).toEqual({ u1: 0.84 });
    });

    it('blocks a customer whose models resolve to different discounts', () => {
        const rules = [rule({ kind: 'customer_model', userId: 'u1', modelId: 'm-a', discount: '0.7' })];
        const out = compileSaleRules(input({ groups: twoModels, rules }));
        expect(out.ownedGroups).toEqual(['pool-gpt']);
        expect(out.blockedCustomers['pool-gpt']).toEqual(['u1']);
        expect(out.customerRows['pool-gpt']).toEqual({});
        expect(out.diagnostics).toEqual([expect.objectContaining({ code: 'customer_unrepresentable', userId: 'u1' })]);
    });

    it('blocks a group whose models resolve to different global discounts', () => {
        const rules = [rule({ kind: 'global_model', modelId: 'm-a', discount: '0.9' })];
        const out = compileSaleRules(input({ groups: twoModels, rules }));
        expect(out.ownedGroups).toEqual([]);
        expect(out.groups['pool-gpt'].blocked).toBe(true);
        expect(out.diagnostics.map((d) => d.code)).toEqual(['group_unrepresentable']);
    });

    it('prefers a model rule over a tier rule within the global layer', () => {
        const rules = [
            rule({ kind: 'global_tier', discount: '0.9' }),
            rule({ kind: 'global_model', modelId: 'm-a', discount: '0.5' }),
        ];
        const out = compileSaleRules(input({ rules }));
        expect(out.groupRatios['pool-gpt']).toBe(0.6);
    });

    it('rejects two overlapping rules of the same specificity', () => {
        const rules = [rule({ kind: 'global_tier', discount: '0.9' }), rule({ kind: 'global_tier', discount: '0.8' })];
        const out = compileSaleRules(input({ rules }));
        expect(out.ownedGroups).toEqual([]);
        expect(out.diagnostics.map((d) => d.code)).toContain('rule_conflict');
    });

    it('allows consecutive rules that do not overlap', () => {
        const switchAt = new Date(NOW.getTime() + 30 * MINUTE);
        const rules = [
            rule({ kind: 'global_tier', discount: '0.9', effectiveTo: switchAt }),
            rule({ kind: 'global_tier', discount: '0.8', effectiveFrom: switchAt }),
        ];
        const out = compileSaleRules(input({ rules }));
        expect(out.diagnostics).toEqual([]);
        expect(out.groupRatios['pool-gpt']).toBe(1.08);
    });

    it('blocks only the conflicting customer', () => {
        const rules = [
            rule({ kind: 'customer_tier', userId: 'u1', discount: '0.9' }),
            rule({ kind: 'customer_tier', userId: 'u1', discount: '0.8' }),
            rule({ kind: 'customer_tier', userId: 'u2', discount: '0.5' }),
        ];
        const out = compileSaleRules(input({ rules }));
        expect(out.ownedGroups).toEqual(['pool-gpt']);
        expect(out.blockedCustomers['pool-gpt']).toEqual(['u1']);
        expect(out.customerRows['pool-gpt']).toEqual({ u2: 0.6 });
    });

    it('blocks discounts on a group that serves a model with a scheduled discount', () => {
        const out = compileSaleRules(
            input({ rules: [rule({ kind: 'global_tier', discount: '0.9' })], scheduledDiscountModels: ['gpt-a'] }),
        );
        expect(out.ownedGroups).toEqual([]);
        expect(out.diagnostics.map((d) => d.code)).toEqual(['scheduled_discount_conflict']);
    });

    it('still manages a scheduled-discount group when no Portal discount applies', () => {
        const out = compileSaleRules(input({ scheduledDiscountModels: ['gpt-a'] }));
        expect(out.groupRatios['pool-gpt']).toBe(1.2);
    });

    it('drops a rule that ends inside the publish window, whichever way it moves the price', () => {
        const ends = new Date(NOW.getTime() + MINUTE);
        const discount = [rule({ kind: 'global_tier', discount: '0.5', effectiveTo: ends })];
        expect(compileSaleRules(input({ rules: discount })).groupRatios['pool-gpt']).toBe(1.2);
        const surcharge = [rule({ kind: 'customer_tier', userId: 'u1', discount: '1.5', effectiveTo: ends })];
        expect(compileSaleRules(input({ rules: surcharge })).customerRows['pool-gpt']).toEqual({});
    });

    it('applies a rule from the first publication after it starts', () => {
        const rules = [rule({ kind: 'global_tier', discount: '0.5', effectiveFrom: new Date(NOW.getTime() + MINUTE) })];
        expect(compileSaleRules(input({ rules })).groupRatios['pool-gpt']).toBe(1.2);
        const later = compileSaleRules(input({ rules, now: new Date(NOW.getTime() + MINUTE) }));
        expect(later.groupRatios['pool-gpt']).toBe(0.6);
    });

    it('keeps a rule that lasts beyond the publish window', () => {
        const rules = [
            rule({
                kind: 'customer_tier',
                userId: 'u1',
                discount: '1.5',
                effectiveTo: new Date(NOW.getTime() + 3 * MINUTE),
            }),
        ];
        expect(compileSaleRules(input({ rules })).customerRows['pool-gpt']).toEqual({ u1: 1.8 });
        const after = compileSaleRules(
            input({ rules, now: new Date(NOW.getTime() + 2 * MINUTE), managedRowUsers: { 'pool-gpt': ['u1'] } }),
        );
        expect(after.customerRows['pool-gpt']).toEqual({});
    });

    it('removes a managed row once its rule is gone', () => {
        const out = compileSaleRules(input({ managedRowUsers: { 'pool-gpt': ['u1'] } }));
        expect(out.customerRows['pool-gpt']).toEqual({});
        expect(out.blockedCustomers['pool-gpt']).toEqual([]);
        expect(out.customers).toEqual([expect.objectContaining({ userId: 'u1', ratio: null, blocked: false })]);
    });

    it('never compiles customers that still hold legacy multipliers', () => {
        const out = compileSaleRules(
            input({ rules: [rule({ kind: 'customer_tier', userId: 'u1', discount: '0.8' })], excludedUserIds: ['u1'] }),
        );
        expect(out.blockedCustomers['pool-gpt']).toEqual(['u1']);
        expect(out.customerRows['pool-gpt']).toEqual({});
        expect(out.diagnostics.map((d) => d.code)).toEqual(['legacy_multiplier']);
    });

    it('blocks the tier for an invalid global rule and only the customer for an invalid customer rule', () => {
        const global = compileSaleRules(input({ rules: [rule({ kind: 'global_tier', discount: '0' })] }));
        expect(global.ownedGroups).toEqual([]);
        const customer = compileSaleRules(
            input({ rules: [rule({ kind: 'customer_tier', userId: 'u1', discount: '3' })] }),
        );
        expect(customer.ownedGroups).toEqual(['pool-gpt']);
        expect(customer.blockedCustomers['pool-gpt']).toEqual(['u1']);
    });

    it('blocks aliases billed under one name with different discounts', () => {
        const catalog = [
            { id: 'm-a', upstreamByTier: { pool: 'gpt-a' } },
            { id: 'm-a2', upstreamByTier: { pool: 'gpt-a' } },
        ];
        const rules = [rule({ kind: 'global_model', modelId: 'm-a', discount: '0.9' })];
        const out = compileSaleRules(input({ catalog, rules }));
        expect(out.diagnostics.map((d) => d.code)).toEqual(['alias_conflict']);
    });

    it('warns about a model rule for a model the tier does not serve', () => {
        const rules = [rule({ kind: 'customer_model', userId: 'u1', modelId: 'm-b', discount: '0.8' })];
        const out = compileSaleRules(input({ rules }));
        expect(out.diagnostics.map((d) => d.code)).toEqual(['model_not_served']);
        expect(out.customerRows['pool-gpt']).toEqual({});
    });

    it('validates rule shape for saving', () => {
        expect(ruleProblems(rule({ kind: 'customer_tier', discount: '0.8' }))).toEqual(['缺少客户']);
        expect(ruleProblems(rule({ kind: 'global_model', discount: '0.04' }))).toEqual([
            '折扣须在 0.05 至 2 之间',
            '缺少模型',
        ]);
        expect(
            ruleProblems(rule({ kind: 'global_tier', discount: '1', effectiveFrom: NOW, effectiveTo: NOW })),
        ).toEqual(['到期时间须晚于生效时间']);
    });
});

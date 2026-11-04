import { describe, expect, it } from 'vitest';
import { selectCatalogDiscount } from '@/lib/billing/catalog-discounts';

const identity = { userId: 'customer-1', modelId: 'model-a', tier: 'standard' };
const base = {
    enabled: true,
    tenantId: null,
    userId: null,
    targets: [{ modelId: 'model-a', tier: 'standard' }],
    discount: 0.68,
    priority: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    effectiveFrom: '2026-11-01T00:00:00.000Z',
    expiresAt: null,
    timezone: 'Asia/Shanghai',
    weekdays: null,
    windows: null,
};

describe('selectCatalogDiscount', () => {
    it('selects exactly one rule by customer-model > promotion > customer, without multiplying discounts', () => {
        const result = selectCatalogDiscount(
            [
                { ...base, id: 'unified', kind: 'customer', userId: identity.userId, discount: 0.9 },
                { ...base, id: 'promo', kind: 'global', discount: 0.8 },
                { ...base, id: 'model', kind: 'customer_model', userId: identity.userId, discount: 0.7 },
            ],
            identity,
            new Date('2026-11-04T04:00:00.000Z'),
        );

        expect(result).toMatchObject({ source: 'customer_model', ruleId: 'model', discount: 0.7 });
    });

    it('isolates customer, model, and tier identities and falls back to the model price', () => {
        const result = selectCatalogDiscount(
            [
                { ...base, id: 'other-customer', kind: 'customer_model', userId: 'customer-2' },
                { ...base, id: 'other-model', kind: 'global', targets: [{ modelId: 'model-b', tier: 'standard' }] },
                {
                    ...base,
                    id: 'other-tier',
                    kind: 'customer',
                    userId: identity.userId,
                    targets: [{ modelId: 'model-a', tier: 'premium' }],
                },
            ],
            identity,
            new Date('2026-11-04T04:00:00.000Z'),
        );

        expect(result).toMatchObject({ source: 'model', ruleId: null, discount: 1 });
    });

    it('matches a cross-midnight window on the selected weekday in Asia/Shanghai', () => {
        const result = selectCatalogDiscount(
            [
                {
                    ...base,
                    id: 'night-sale',
                    kind: 'global',
                    weekdays: [1],
                    windows: [{ start: '22:00', end: '02:00', discount: 0.6 }],
                },
            ],
            identity,
            new Date('2026-11-02T17:30:00.000Z'), // Tuesday 01:30, Monday window continuation
        );

        expect(result).toMatchObject({ source: 'global', ruleId: 'night-sale', discount: 0.6 });
    });

    it('uses priority then earlier creation time for overlapping promotion rules', () => {
        const result = selectCatalogDiscount(
            [
                {
                    ...base,
                    id: 'later-created',
                    kind: 'global',
                    priority: 2,
                    createdAt: '2026-11-02T00:00:00.000Z',
                    discount: 0.5,
                },
                {
                    ...base,
                    id: 'earlier-created',
                    kind: 'global',
                    priority: 2,
                    createdAt: '2026-11-01T00:00:00.000Z',
                    discount: 0.7,
                },
                {
                    ...base,
                    id: 'lower-priority',
                    kind: 'global',
                    priority: 1,
                    createdAt: '2026-10-31T00:00:00.000Z',
                    discount: 0.4,
                },
            ],
            identity,
            new Date('2026-11-04T04:00:00.000Z'),
        );

        expect(result).toMatchObject({ source: 'global', ruleId: 'earlier-created', discount: 0.7 });
    });

    it('uses the highest-priority matching window discount', () => {
        const result = selectCatalogDiscount(
            [
                {
                    ...base,
                    id: 'promotion',
                    kind: 'global',
                    windows: [
                        { start: '09:00', end: '17:00', discount: 0.8, priority: 1 },
                        { start: '10:00', end: '12:00', discount: 0.6, priority: 5 },
                    ],
                },
            ],
            identity,
            new Date('2026-11-04T03:00:00.000Z'),
        );

        expect(result).toMatchObject({ source: 'global', discount: 0.6 });
    });

    it('rejects overlapping matching windows with the same priority', () => {
        expect(() =>
            selectCatalogDiscount(
                [
                    {
                        ...base,
                        id: 'ambiguous-promotion',
                        kind: 'global',
                        windows: [
                            { start: '09:00', end: '17:00', discount: 0.8, priority: 3 },
                            { start: '10:00', end: '12:00', discount: 0.6, priority: 3 },
                        ],
                    },
                ],
                identity,
                new Date('2026-11-04T03:00:00.000Z'),
            ),
        ).toThrow(/ambiguous/i);
    });

    it('validates malformed disabled windows before ignoring them', () => {
        expect(() =>
            selectCatalogDiscount(
                [
                    {
                        ...base,
                        id: 'corrupt-disabled-window',
                        kind: 'global',
                        windows: [{ start: '25:00', end: '02:00', discount: 0.6, enabled: false }],
                    },
                ],
                identity,
                new Date('2026-11-04T03:00:00.000Z'),
            ),
        ).toThrow(/window/i);
    });

    it('uses the most specific matching target regardless of target order', () => {
        const result = selectCatalogDiscount(
            [
                {
                    ...base,
                    id: 'promotion',
                    kind: 'global',
                    targets: [
                        { modelId: null, tier: 'standard' },
                        { modelId: 'model-a', tier: 'standard' },
                    ],
                    discount: 0.6,
                },
            ],
            identity,
            new Date('2026-11-04T04:00:00.000Z'),
        );

        expect(result).toMatchObject({ source: 'global', ruleId: 'promotion', discount: 0.6 });
    });

    it('fails closed when a matching stored discount is invalid', () => {
        expect(() =>
            selectCatalogDiscount(
                [{ ...base, id: 'corrupt', kind: 'customer_model', userId: identity.userId, discount: Number.NaN }],
                identity,
                new Date('2026-11-04T04:00:00.000Z'),
            ),
        ).toThrow(/discount|pricing/i);
    });
});

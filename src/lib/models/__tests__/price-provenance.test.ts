import { describe, expect, it } from 'vitest';
import { BASE_FX } from '@/lib/admin/pricing-simple-core';
import { computeVideoQuote, videoQuoteCostConfig } from '@/lib/admin/pricing-video-quote';
import { VIDEO_TOKEN_COMBOS, videoTokenKey } from '@/lib/admin/pricing-video-token-expression';
import type { TierPricing } from '../machine-catalog';
import { resolvePriceProvenance, type PriceProvenanceVerification } from '../price-provenance';

const groupRatio = 0.16;
const mapping = { channel_id: 7, upstream_model: 'ark-seedance-model' };
const official = VIDEO_TOKEN_COMBOS.map((combo, index) => ({ ...combo, price: 31 + index * 3 }));
const config = videoQuoteCostConfig({ official, buy_discount: 0.5, sell_discount: 0.75 });
const verification: PriceProvenanceVerification = {
    mapping,
    rule: { ...mapping, config },
    groupRatio,
};

function videoPrice(
    actuals = computeVideoQuote({ official, buy_discount: 0.5, sell_discount: 0.75 }, BASE_FX, groupRatio).map(
        (cell) => cell.actual,
    ),
): TierPricing {
    return {
        input_cny_per_1m: null,
        output_cny_per_1m: null,
        per_image_cny: null,
        billing_details: {
            version: 1,
            mode: 'video_token',
            unit: 'cny_per_million_tokens',
            cells: VIDEO_TOKEN_COMBOS.map((combo, index) => ({
                ...combo,
                price: actuals[index],
            })),
        },
    };
}

const unverified = {
    source: 'catalog',
    official: null,
    discount: null,
    discountBasis: null,
    verifiable: false,
};

describe('resolvePriceProvenance', () => {
    it('does not invent provenance for ordinary catalog prices', () => {
        expect(
            resolvePriceProvenance('gpt-5.6-sol', {
                input_cny_per_1m: 0.75,
                output_cny_per_1m: 6,
                per_image_cny: null,
            }),
        ).toEqual(unverified);
    });

    it('uses the saved rule reference and configured 75% sale rate, even when it differs from the static table', () => {
        const price = videoPrice();
        const provenance = resolvePriceProvenance('seedance2.0-pro-720p', price, verification);
        const summaryRate = official.find(
            (cell) => videoTokenKey(cell) === videoTokenKey({ resolution: '720p', video_input: 'none' }),
        )!;
        expect(provenance).toEqual({
            source: 'pricing_cost_rule',
            official: summaryRate.price,
            discount: 0.75,
            discountBasis: 'configured_pricing_cost_rule',
            verifiable: true,
        });
        expect(summaryRate.price).not.toBe(46);
    });

    it('requires current route, rule and GroupRatio evidence', () => {
        expect(resolvePriceProvenance('seedance2.0-pro-720p', videoPrice())).toEqual(unverified);
        expect(resolvePriceProvenance('seedance2.0-pro-720p', videoPrice(), { ...verification, rule: null })).toEqual(
            unverified,
        );
        expect(
            resolvePriceProvenance('seedance2.0-pro-720p', videoPrice(), { ...verification, mapping: null }),
        ).toEqual(unverified);
        expect(
            resolvePriceProvenance('seedance2.0-pro-720p', videoPrice(), { ...verification, groupRatio: null }),
        ).toEqual(unverified);
    });

    it('rejects a rule whose channel or upstream model no longer matches the current mapping', () => {
        expect(
            resolvePriceProvenance('seedance2.0-pro-720p', videoPrice(), {
                ...verification,
                rule: { ...verification.rule!, channel_id: 8 },
            }),
        ).toEqual(unverified);
        expect(
            resolvePriceProvenance('seedance2.0-pro-720p', videoPrice(), {
                ...verification,
                rule: { ...verification.rule!, upstream_model: 'stale-model' },
            }),
        ).toEqual(unverified);
    });

    it('rejects incomplete or price-drifted catalog cells', () => {
        const full = videoPrice();
        if (full.billing_details?.mode !== 'video_token') throw new Error('Expected video pricing details');
        expect(
            resolvePriceProvenance(
                'seedance2.0-pro-720p',
                {
                    ...full,
                    billing_details: { ...full.billing_details, cells: full.billing_details.cells.slice(0, 7) },
                },
                verification,
            ),
        ).toEqual(unverified);
        const drifted = videoPrice();
        if (drifted.billing_details?.mode !== 'video_token') throw new Error('Expected video pricing details');
        const cells = [...drifted.billing_details.cells];
        cells[3] = { ...cells[3], price: cells[3].price + 0.01 };
        expect(
            resolvePriceProvenance(
                'seedance2.0-pro-720p',
                {
                    ...drifted,
                    billing_details: { ...drifted.billing_details, cells },
                },
                verification,
            ),
        ).toEqual(unverified);
    });

    it('rejects GroupRatio drift and scheduled discounts', () => {
        expect(
            resolvePriceProvenance('seedance2.0-pro-720p', videoPrice(), {
                ...verification,
                groupRatio: 0.2,
            }),
        ).toEqual(unverified);
        const full = videoPrice();
        expect(
            resolvePriceProvenance(
                'seedance2.0-pro-720p',
                {
                    ...full,
                    billing_details: {
                        ...full.billing_details!,
                        scheduled_discount: {
                            start: '00:00',
                            end: '08:00',
                            timezone: 'Asia/Shanghai',
                            multiplier: 0.75,
                        },
                    },
                },
                verification,
            ),
        ).toEqual(unverified);
    });

    it.each(['seedance2.5-global-720p', 'seedance2.5-promax-720p', 'doubao-seedance-2-5-260628'])(
        'does not infer provenance from non-domestic or native slug %s',
        (slug) => {
            expect(resolvePriceProvenance(slug, videoPrice(), verification)).toEqual(unverified);
        },
    );
});

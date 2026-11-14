import { videoTokenSummaryCell, type VideoTokenPricingDetails } from './catalog-pricing-details';
import type { TierPricing } from './machine-catalog';
import { pricingCostConfigSchema } from '@/lib/admin/pricing-cost';
import { computeVideoQuote, videoQuoteFromCostConfig } from '@/lib/admin/pricing-video-quote';
import { BASE_FX } from '@/lib/admin/pricing-simple-core';
import { VIDEO_TOKEN_COMBOS, videoTokenKey } from '@/lib/admin/pricing-video-token-expression';

/** A displayed Seedance discount is verifiable only against its active operator-maintained rule. */
export interface PriceProvenance {
    source: 'catalog' | 'pricing_cost_rule';
    /** Reference rate saved in the cost rule for the summary cell, in CNY / million tokens. */
    official: number | null;
    /** Configured sale fraction (0.75 means 75 折); customer-specific scaling is separate. */
    discount: number | null;
    discountBasis: 'configured_pricing_cost_rule' | null;
    verifiable: boolean;
}

export interface PriceProvenanceVerification {
    /** Current, topology-validated model route for this tier. */
    mapping: { channel_id: number; upstream_model: string } | null;
    /** Current cost rule row for this model/tier, or null when none is saved. */
    rule: {
        channel_id: number;
        upstream_model: string;
        config: unknown;
    } | null;
    /** Live GroupRatio for the tier's new-api billing group. */
    groupRatio: number | null;
}

const UNVERIFIED: PriceProvenance = {
    source: 'catalog',
    official: null,
    discount: null,
    discountBasis: null,
    verifiable: false,
};

/**
 * Restrict the note to the portal's established domestic Seedance catalog aliases.
 * The regex identifies eligible products only; it does not provide any reference prices.
 */
function domesticArkModel(slug: string): { resolution: string } | null {
    const name = slug.toLowerCase();
    const match20 = /^seedance2\.0-(?:pro|fast|mini)-(480p|720p|1080p|4k)(?:-ref)?$/.exec(name);
    if (match20) return { resolution: match20[1] };
    const match25 = /^seedance2\.5-(480p|720p|1080p)(?:-ref)?$/.exec(name);
    if (match25) return { resolution: match25[1] };
    return null;
}

function closeEnough(a: number, b: number): boolean {
    return (
        Number.isFinite(a) &&
        Number.isFinite(b) &&
        Math.abs(a - b) <= 0.000001 + Math.max(Math.abs(a), Math.abs(b)) * 1e-9
    );
}

function verifyLiveQuote(
    details: VideoTokenPricingDetails,
    verification: PriceProvenanceVerification,
): { official: number; discount: number } | null {
    const { mapping, rule, groupRatio } = verification;
    if (!mapping || !rule || groupRatio === null || !Number.isFinite(groupRatio) || groupRatio <= 0) return null;
    if (
        mapping.channel_id !== rule.channel_id ||
        mapping.upstream_model !== rule.upstream_model ||
        !Number.isSafeInteger(mapping.channel_id) ||
        mapping.channel_id <= 0 ||
        !mapping.upstream_model.trim()
    )
        return null;
    if (details.scheduled_discount || details.cells.length !== VIDEO_TOKEN_COMBOS.length) return null;

    const parsed = pricingCostConfigSchema.safeParse(rule.config);
    if (!parsed.success) return null;
    const quote = videoQuoteFromCostConfig(parsed.data);
    if (!quote || quote.sell_discount > 1) return null;
    try {
        const computed = computeVideoQuote(quote, BASE_FX, groupRatio);
        if (computed.length !== VIDEO_TOKEN_COMBOS.length) return null;
        const catalogByKey = new Map(details.cells.map((cell) => [videoTokenKey(cell), cell]));
        if (catalogByKey.size !== VIDEO_TOKEN_COMBOS.length) return null;

        // The operator-maintained rule is the reference source. Recompute the actual public
        // quote for every resolution/reference-video combination, then compare every cell.
        for (const cell of computed) {
            const catalog = catalogByKey.get(videoTokenKey(cell));
            if (!catalog || !closeEnough(catalog.price, cell.actual)) return null;
        }

        const summary = videoTokenSummaryCell(details);
        const summaryRate = quote.official.find((cell) => videoTokenKey(cell) === videoTokenKey(summary));
        if (!summaryRate) return null;
        return { official: summaryRate.price, discount: quote.sell_discount };
    } catch {
        return null;
    }
}

/**
 * Verify the public catalog price against the current saved cost rule, current route mapping,
 * and live GroupRatio. Static reference tables are intentionally not used as proof or a gate.
 */
export function resolvePriceProvenance(
    slug: string,
    publicPrice: TierPricing,
    verification?: PriceProvenanceVerification,
): PriceProvenance {
    const alias = domesticArkModel(slug);
    const details = publicPrice.billing_details;
    if (!alias || details?.mode !== 'video_token' || !verification) return UNVERIFIED;
    if (!details.cells.some((cell) => cell.resolution === alias.resolution)) return UNVERIFIED;

    const verified = verifyLiveQuote(details, verification);
    if (!verified) return UNVERIFIED;
    return {
        source: 'pricing_cost_rule',
        official: verified.official,
        discount: verified.discount,
        discountBasis: 'configured_pricing_cost_rule',
        verifiable: true,
    };
}

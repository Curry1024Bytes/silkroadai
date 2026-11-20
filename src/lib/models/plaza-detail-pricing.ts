import 'server-only';

import type { TieredPricingDetails } from '@/lib/admin/pricing-publish-types';
import { catalogMatches, groupRatioOf } from '@/lib/admin/pricing-simple-core';
import { readSyncPrice, syncPricesFromOptions } from '@/lib/newapi/catalog-sync-prices';
import { syncDictionary } from '@/lib/newapi/catalog-sync-advanced';
import { sanitizeCatalogDisplayDetails } from './catalog-pricing-details';
import type { PlazaPriceBreakdown } from './plaza-types';
import type { TierPricing } from './machine-catalog';

/** Show a new-api base and its public factor only when they reproduce the published Portal tariff. */
export function verifiedPlazaBreakdown(
    options: Record<string, unknown>,
    upstreamModel: string,
    publicGroup: string,
    slug: string,
    published: TierPricing,
): PlazaPriceBreakdown | null {
    try {
        const groupMultiplier = groupRatioOf(options, publicGroup);
        if (groupMultiplier === null) return null;
        const raw = syncPricesFromOptions(options);
        const expected = readSyncPrice(raw, upstreamModel, publicGroup).price;
        if (!expected) return null;
        const comparable = (quote: TierPricing | NonNullable<typeof expected>) => ({
            ...quote,
            billing_details: sanitizeCatalogDisplayDetails(slug, quote.billing_details ?? null),
        });
        const have = comparable(published);
        const want = comparable(expected);
        if (!catalogMatches(have, want)) return null;
        if (have.billing_details?.mode === 'tiered_token' && want.billing_details?.mode === 'tiered_token') {
            const conditions = ({ tiers, request_multipliers, scheduled_discount }: TieredPricingDetails) => ({
                tiers: tiers.map(({ min_input_tokens, min_inclusive }) => [min_input_tokens, min_inclusive]),
                request_multipliers: request_multipliers ?? [],
                scheduled_discount: scheduled_discount ?? null,
            });
            if (JSON.stringify(conditions(have.billing_details)) !== JSON.stringify(conditions(want.billing_details)))
                return null;
        } else if (Boolean(have.billing_details) !== Boolean(want.billing_details)) {
            return null;
        }
        const base = readSyncPrice({ ...raw, groupRatio: { [publicGroup]: 1 } }, upstreamModel, publicGroup).price;
        if (!base) return null;
        const { billing_details, ...amounts } = comparable(base);
        const modes = syncDictionary(raw.billingMode, 'billing_mode');
        return {
            base: { ...amounts, ...(billing_details ? { billing_details } : {}) },
            groupMultiplier,
            dynamic: Object.hasOwn(modes, upstreamModel) && modes[upstreamModel] === 'tiered_expr',
        };
    } catch {
        // Optional detail. The existing customer price remains available independently.
        return null;
    }
}

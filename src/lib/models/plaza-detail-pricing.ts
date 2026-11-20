import 'server-only';

import type { TieredPricingDetails } from '@/lib/admin/pricing-publish-types';
import { BASE_FX, catalogMatches, groupRatioOf, readBasePrice } from '@/lib/admin/pricing-simple-core';
import { readSyncPrice, syncPricesFromOptions } from '@/lib/newapi/catalog-sync-prices';
import { syncDictionary } from '@/lib/newapi/catalog-sync-advanced';
import { sanitizeCatalogDisplayDetails } from './catalog-pricing-details';
import { flattenBase, officialMultiplierOf } from '@/lib/customer-pricing/math';
import type { PlazaPriceBreakdown } from './plaza-types';
import type { TierPricing } from './machine-catalog';

/** Reconcile native rates with the catalog before using their shape for a confirmed official reference. */
export function verifiedPlazaBreakdown(
    options: Record<string, unknown>,
    upstreamModel: string,
    publicGroup: string,
    slug: string,
    published: TierPricing,
    reference?: { shape: string; cells: unknown },
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
        const modes = syncDictionary(raw.billingMode, 'billing_mode');
        const dynamic = Object.hasOwn(modes, upstreamModel) && modes[upstreamModel] === 'tiered_expr';
        if (!reference) return dynamic ? { dynamic } : null;
        try {
            const native = readBasePrice(options, upstreamModel);
            if (!native || !Array.isArray(reference.cells)) return { dynamic };
            const flat = flattenBase(native, BASE_FX);
            if (flat.shape !== reference.shape || flat.cells.length !== reference.cells.length) return { dynamic };
            const rates = new Map<string, number>();
            for (const cell of reference.cells) {
                if (
                    !cell ||
                    typeof cell.key !== 'string' ||
                    rates.has(cell.key) ||
                    typeof cell.official_cny !== 'number' ||
                    !Number.isFinite(cell.official_cny) ||
                    cell.official_cny < 0
                )
                    return { dynamic };
                rates.set(cell.key, cell.official_cny);
            }
            if (flat.cells.some((cell) => !rates.has(cell.key))) return { dynamic };
            const cells = flat.cells.map((cell) => ({
                ...cell,
                base_cny: cell.amount,
                official_cny: rates.get(cell.key)!,
                public_cny: 0,
                cost_cny: null,
            }));
            const details = have.billing_details;
            const multiplier = officialMultiplierOf(cells, groupMultiplier);
            const base: TierPricing = {
                input_cny_per_1m: rates.get('0:input') ?? null,
                output_cny_per_1m: rates.get('0:output') ?? null,
                per_image_cny: rates.get('call') ?? null,
            };
            if (details?.mode === 'video_token') {
                base.billing_details = {
                    ...details,
                    cells: details.cells.map((cell) => ({
                        ...cell,
                        price: rates.get(`${cell.resolution}·${cell.video_input}`)!,
                    })),
                };
            } else if (details?.mode === 'tiered_token') {
                base.billing_details = {
                    ...details,
                    tiers: details.tiers.map((tier, index) => ({
                        ...tier,
                        rates: {
                            input: rates.get(`${index}:input`)!,
                            output: rates.get(`${index}:output`)!,
                            cache_read: rates.get(`${index}:cache_read`) ?? null,
                            cache_write: rates.get(`${index}:cache_write`) ?? null,
                            cache_write_1h: rates.get(`${index}:cache_write_1h`) ?? null,
                            cache_write_12h: rates.get(`${index}:cache_write_12h`) ?? null,
                        },
                    })),
                };
            } else if (details) {
                return { dynamic };
            }
            return {
                dynamic,
                base,
                ...(multiplier !== null ? { groupMultiplier: multiplier } : {}),
            };
        } catch {
            return { dynamic };
        }
    } catch {
        // Optional detail. The existing customer price remains available independently.
        return null;
    }
}

import 'server-only';

import {
    SD_SPECIAL_GROUP,
    SD_SPECIAL_MODELS,
    isSdSpecialLegacyModel,
    isSdSpecialPublicModel,
    sdSpecialPrices,
} from '@/lib/sd-special-video';

import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { ChannelGroupTopology } from '@/lib/channel-group-topology';
import { HIDDEN_MODELS } from '@/lib/models/categorize';
import type { BrowserCatalog, BrowserModelPricing } from '@/lib/models/catalog-browser-types';
import type { TierPricing } from '@/lib/models/machine-catalog';
import { scalePricingAmount } from '@/lib/models/tiered-pricing-details';
import type { PartnerPriceDisplay } from '@/lib/partner/display-pricing';
import {
    parseCatalogBillingDetails,
    sanitizeCatalogDisplayDetails,
    scaleCatalogBillingDetails,
} from './catalog-pricing-details';
import { getOption, getPricingPublishOptions } from '@/lib/newapi/client';
import { listUserTierMultipliers } from '@/lib/newapi/user-tier-multiplier';
import { resolveVideoPriceEvidence, type PriceProvenanceVerification } from './price-provenance';
import { loadCustomerOfficialQuotes } from '@/lib/customer-pricing/presentation';
import { verifiedPlazaBreakdown } from './plaza-detail-pricing';
import type { PlazaPriceBreakdown } from './plaza-types';

export type { BrowserCatalog, BrowserModelPricing, BrowserTier } from '@/lib/models/catalog-browser-types';

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valueToNumber(value: unknown): number | null {
    return value == null ? null : Number(value);
}

/** Validate membership without publishing channel IDs, upstream names, or internal billing groups. */
function currentMemberships(raw: unknown, topology: ChannelGroupTopology): string[] {
    if (!isRecord(raw)) return [];
    return topology.groups.flatMap((group) => {
        if (!Object.hasOwn(raw, group.key)) return [];
        const entry = raw[group.key];
        if (
            !isRecord(entry) ||
            typeof entry.channel_id !== 'number' ||
            !Number.isSafeInteger(entry.channel_id) ||
            entry.channel_id <= 0 ||
            typeof entry.upstream_model !== 'string' ||
            !entry.upstream_model.trim()
        )
            return [];
        const issues = topology.validateUpstreamMap({
            [group.key]: { channel_id: entry.channel_id, upstream_model: entry.upstream_model },
        });
        return issues.length === 0 ? [group.key] : [];
    });
}

function currentMapping(
    raw: unknown,
    tier: string,
    topology: ChannelGroupTopology,
): { channel_id: number; upstream_model: string } | null {
    if (!isRecord(raw)) return null;
    const entry = raw[tier];
    if (
        !isRecord(entry) ||
        typeof entry.channel_id !== 'number' ||
        !Number.isSafeInteger(entry.channel_id) ||
        entry.channel_id <= 0 ||
        typeof entry.upstream_model !== 'string' ||
        !entry.upstream_model.trim()
    )
        return null;
    const mapping = { channel_id: entry.channel_id, upstream_model: entry.upstream_model };
    return topology.validateUpstreamMap({ [tier]: mapping }).length === 0 ? mapping : null;
}

function parsePublicGroupRatios(raw: string | null): Map<string, number> {
    if (!raw) return new Map();
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) return new Map();
        return new Map(
            Object.entries(parsed).flatMap(([key, value]) =>
                typeof value === 'number' && Number.isFinite(value) && value > 0 ? [[key, value] as const] : [],
            ),
        );
    } catch {
        return new Map();
    }
}

type VideoRuleRow = {
    tier: string;
    channel_id: number;
    upstream_model: string;
    config: unknown;
    model: { slug: string };
};

async function customerScales(
    topology: ChannelGroupTopology,
    overrides: Awaited<ReturnType<typeof listUserTierMultipliers>>,
): Promise<Map<string, number>> {
    const byBillingGroup = new Map(topology.groups.map((group) => [group.newapi_group, group]));
    const applicable = new Map<string, number>();
    for (const override of overrides) {
        const tier = topology.byTier.get(override.tier_key);
        const billingGroup = byBillingGroup.get(override.newapi_billing_group);
        // Rules belonging wholly to retired tiers do not create public memberships.
        if (!tier && !billingGroup) continue;
        if (!tier || tier !== billingGroup || applicable.has(tier.key))
            throw new Error('Cannot verify dedicated customer price');
        const multiplier = Number(override.multiplier);
        if (!Number.isFinite(multiplier) || multiplier < 0) throw new Error('Cannot verify dedicated customer price');
        applicable.set(tier.key, multiplier);
    }
    // Public catalog reads and ordinary customers use the persisted retail prices directly.
    if (applicable.size === 0) return new Map();

    const raw: unknown = JSON.parse((await getOption('GroupRatio')) ?? 'null');
    if (!isRecord(raw)) throw new Error('Cannot verify dedicated customer price');
    const scales = new Map<string, number>();
    for (const [tierKey, dedicatedMultiplier] of applicable) {
        const billingGroup = topology.byTier.get(tierKey)!.newapi_group;
        const publicMultiplier = Object.hasOwn(raw, billingGroup) ? raw[billingGroup] : undefined;
        if (typeof publicMultiplier !== 'number' || !Number.isFinite(publicMultiplier) || publicMultiplier <= 0)
            throw new Error('Cannot verify dedicated customer price');
        const scale = dedicatedMultiplier / publicMultiplier;
        scalePricingAmount(0, scale);
        scales.set(tierKey, scale);
    }
    return scales;
}

/**
 * Display catalog shared by the public and signed-in model browsers. ChannelGroup and
 * CatalogModel are the Portal membership source; new-api remains the request router.
 * Deliberately uncached so price publications and customer overrides appear on refresh.
 * Failures propagate: callers must not substitute a different tier or a public customer quote.
 */
export async function loadBrowserCatalog(
    userId?: string,
    {
        includePriceBreakdown = false,
        useNewApiGroupNames = false,
        partner = null,
    }: { includePriceBreakdown?: boolean; useNewApiGroupNames?: boolean; partner?: PartnerPriceDisplay | null } = {},
): Promise<BrowserCatalog> {
    // 代理站点按代理零售率显示，不套平台客户专属价。
    const officialQuotes = userId && !partner ? await loadCustomerOfficialQuotes(userId) : new Map<string, TierPricing>();
    const [models, groups, overrides, displayOptions, references] = await Promise.all([
        prisma.catalogModel.findMany({
            where: { enabled: true, tenant_id: PLATFORM_TENANT_ID },
            orderBy: [{ sort_order: 'asc' }, { slug: 'asc' }],
            select: {
                id: true,
                slug: true,
                upstream_map: true,
                prices: {
                    where: { effective_from: { lte: new Date() } },
                    orderBy: { effective_from: 'desc' },
                    select: {
                        tier: true,
                        input_cny_per_1m: true,
                        output_cny_per_1m: true,
                        per_image_cny: true,
                        billing_details: true,
                    },
                },
            },
        }),
        prisma.channelGroup.findMany({
            where: { enabled: true, tenant_id: PLATFORM_TENANT_ID },
            orderBy: [{ tier_level: 'asc' }, { key: 'asc' }],
            select: {
                key: true,
                display_name: true,
                newapi_group: true,
                newapi_channel_ids: true,
                is_default: true,
                enabled: true,
                tier_level: true,
                upstream_synced_at: true,
            },
        }),
        userId && !partner ? listUserTierMultipliers(userId) : Promise.resolve([]),
        includePriceBreakdown ? getPricingPublishOptions(2500).catch(() => null) : Promise.resolve(null),
        includePriceBreakdown
            ? prisma.customerOfficialReference
                  .findMany({
                      where: { tenant_id: PLATFORM_TENANT_ID },
                      select: { model_id: true, tier_key: true, shape: true, cells: true },
                  })
                  .catch(() => [])
            : Promise.resolve([]),
    ]);

    const referenceByModelTier = new Map(references.map((row) => [`${row.model_id}\u0000${row.tier_key}`, row]));
    const topology = new ChannelGroupTopology(PLATFORM_TENANT_ID, groups);
    const scales = partner ? partner.scales : await customerScales(topology, overrides);

    // Cost rules and GroupRatio are only needed for video-token provenance. Keep ordinary
    // catalog reads on their existing query/mocking path and hide the provenance marker when
    // this independent evidence is unavailable or stale.
    const videoSlugs = [
        ...new Set(
            models
                .filter((model) =>
                    model.prices.some(
                        (price) => isRecord(price.billing_details) && price.billing_details.mode === 'video_token',
                    ),
                )
                .map((model) => model.slug),
        ),
    ];
    let videoRules: VideoRuleRow[] = [];
    let publicGroupRatios = new Map<string, number>();
    if (videoSlugs.length) {
        try {
            [videoRules, publicGroupRatios] = await Promise.all([
                prisma.pricingCostRule.findMany({
                    where: {
                        model: {
                            tenant_id: PLATFORM_TENANT_ID,
                            enabled: true,
                            slug: { in: videoSlugs },
                        },
                    },
                    select: {
                        tier: true,
                        channel_id: true,
                        upstream_model: true,
                        config: true,
                        model: { select: { slug: true } },
                    },
                }),
                displayOptions && typeof displayOptions.GroupRatio === 'string'
                    ? Promise.resolve(parsePublicGroupRatios(displayOptions.GroupRatio))
                    : getOption('GroupRatio').then(parsePublicGroupRatios),
            ]);
        } catch {
            // Evidence is optional; if it cannot be read, preserve the catalog and omit the note.
            videoRules = [];
            publicGroupRatios = new Map();
        }
    }
    const videoRulesByKey = new Map(videoRules.map((rule) => [`${rule.model.slug}\u0000${rule.tier}`, rule] as const));
    const visibleModels: BrowserModelPricing[] = [];
    for (const model of models) {
        if (HIDDEN_MODELS.has(model.slug)) continue;
        const allMemberships = currentMemberships(model.upstream_map, topology);
        const memberships = partner
            ? allMemberships.filter((tier) => partner.openTiers.has(tier))
            : allMemberships;
        if (memberships.length === 0) continue;
        const latestPrices = new Map<string, (typeof model.prices)[number]>();
        for (const price of model.prices) {
            if (!latestPrices.has(price.tier)) latestPrices.set(price.tier, price);
        }
        const breakdownByTier: Record<string, PlazaPriceBreakdown> = {};
        const pricesByTier = Object.fromEntries(
            memberships.map((tier): [string, TierPricing | null] => {
                const price = latestPrices.get(tier);
                if (!price) return [tier, null];
                const scale = scales.get(tier) ?? 1;
                const publicDetails = parseCatalogBillingDetails(price.billing_details);
                const details = publicDetails ? scaleCatalogBillingDetails(publicDetails, scale) : null;
                const tokenRates = details?.mode === 'tiered_token' ? details.tiers[0].rates : null;
                const amount = (value: unknown): number | null =>
                    value == null ? null : scalePricingAmount(Number(value), scale);
                const publicPricing: TierPricing = {
                    input_cny_per_1m:
                        publicDetails?.mode === 'tiered_token'
                            ? publicDetails.tiers[0].rates.input
                            : valueToNumber(price.input_cny_per_1m),
                    output_cny_per_1m:
                        publicDetails?.mode === 'tiered_token'
                            ? publicDetails.tiers[0].rates.output
                            : valueToNumber(price.output_cny_per_1m),
                    per_image_cny: valueToNumber(price.per_image_cny),
                    ...(publicDetails ? { billing_details: publicDetails } : {}),
                };
                const reference = referenceByModelTier.get(`${model.id}\u0000${tier}`);
                if (displayOptions) {
                    const group = topology.byTier.get(tier);
                    const mapping = currentMapping(model.upstream_map, tier, topology);
                    if (group && mapping) {
                        const breakdown = verifiedPlazaBreakdown(
                            displayOptions,
                            mapping.upstream_model,
                            group.newapi_group,
                            model.slug,
                            publicPricing,
                            reference,
                        );
                        if (breakdown) breakdownByTier[tier] = breakdown;
                    }
                }
                let pricing: TierPricing = {
                    input_cny_per_1m: tokenRates?.input ?? amount(price.input_cny_per_1m),
                    output_cny_per_1m: tokenRates?.output ?? amount(price.output_cny_per_1m),
                    per_image_cny: amount(price.per_image_cny),
                    ...(details ? { billing_details: details } : {}),
                };
                const hasPrice =
                    pricing.input_cny_per_1m !== null ||
                    pricing.output_cny_per_1m !== null ||
                    pricing.per_image_cny !== null ||
                    !!details;
                if (!hasPrice) return [tier, null];
                if (publicDetails?.mode === 'video_token') {
                    const group = topology.byTier.get(tier);
                    const rule = videoRulesByKey.get(`${model.slug}\u0000${tier}`);
                    const verification: PriceProvenanceVerification = {
                        mapping: currentMapping(model.upstream_map, tier, topology),
                        rule: rule
                            ? {
                                  channel_id: rule.channel_id,
                                  upstream_model: rule.upstream_model,
                                  config: rule.config,
                              }
                            : null,
                        groupRatio: group ? (publicGroupRatios.get(group.newapi_group) ?? null) : null,
                    };
                    const evidence = resolveVideoPriceEvidence(model.slug, publicPricing, verification);
                    if (evidence) {
                        pricing.price_provenance = evidence.provenance;
                        if (includePriceBreakdown && !reference) {
                            const { version, mode, unit } = publicDetails;
                            breakdownByTier[tier] = {
                                base: {
                                    input_cny_per_1m: null,
                                    output_cny_per_1m: null,
                                    per_image_cny: null,
                                    billing_details: { version, mode, unit, cells: evidence.officialCells },
                                },
                                ...(evidence.publicOfficialMultiplier === null
                                    ? {}
                                    : { groupMultiplier: evidence.publicOfficialMultiplier }),
                                dynamic: true,
                            };
                        }
                    }
                }
                const officialQuote = officialQuotes.get(`${model.slug}\u0000${tier}`);
                if (officialQuote) pricing = { ...officialQuote, price_provenance: pricing.price_provenance };
                else if (scale !== 1 && !partner) {
                    const standard = pricing.price_provenance?.verifiable ? pricing.price_provenance.discount : null;
                    pricing.customer_pricing = {
                        basis: 'public',
                        multiplier: scale,
                        scope: 'tier',
                        public_official_multiplier: standard ?? null,
                        official_multiplier: standard == null ? null : scalePricingAmount(standard, scale),
                    };
                }
                const displayDetails = sanitizeCatalogDisplayDetails(model.slug, pricing.billing_details ?? null);
                return [tier, displayDetails ? { ...pricing, billing_details: displayDetails } : pricing];
            }),
        );
        visibleModels.push({
            slug: model.slug,
            pricesByTier,
            ...(Object.keys(breakdownByTier).length ? { breakdownByTier } : {}),
        });
    }

    const sdTier = groups.find((group) => group.newapi_group === SD_SPECIAL_GROUP)?.key;
    const bySlug = new Map(visibleModels.map((model) => [model.slug, model]));
    const publicModels = visibleModels.filter(
        (model) => !isSdSpecialLegacyModel(model.slug) && !isSdSpecialPublicModel(model.slug),
    );
    if (sdTier) {
        for (const slug of Object.keys(SD_SPECIAL_MODELS).filter(isSdSpecialPublicModel)) {
            const pricing = sdSpecialPrices(slug, (sku) => bySlug.get(sku)?.pricesByTier[sdTier]);
            if (pricing) publicModels.push({ slug, pricesByTier: { [sdTier]: pricing } });
        }
    }

    return {
        tiers: groups.map((group) => ({
            key: group.key,
            label: useNewApiGroupNames ? group.newapi_group : group.display_name,
            isDefault: group.is_default,
        })),
        models: publicModels,
    };
}

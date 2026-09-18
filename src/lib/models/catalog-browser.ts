import 'server-only';

import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { ChannelGroupTopology } from '@/lib/channel-group-topology';
import { HIDDEN_MODELS } from '@/lib/models/categorize';
import type { BrowserCatalog, BrowserModelPricing } from '@/lib/models/catalog-browser-types';
import type { TierPricing } from '@/lib/models/machine-catalog';
import {
    parseTieredPricingDetails,
    scalePricingAmount,
    scaleTieredPricingDetails,
} from '@/lib/models/tiered-pricing-details';
import { getOption } from '@/lib/newapi/client';
import { listUserTierMultipliers } from '@/lib/newapi/user-tier-multiplier';

export type { BrowserCatalog, BrowserModelPricing, BrowserTier } from '@/lib/models/catalog-browser-types';

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
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
export async function loadBrowserCatalog(userId?: string): Promise<BrowserCatalog> {
    const [models, groups, overrides] = await Promise.all([
        prisma.catalogModel.findMany({
            where: { enabled: true, tenant_id: PLATFORM_TENANT_ID },
            orderBy: [{ sort_order: 'asc' }, { slug: 'asc' }],
            select: {
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
            },
        }),
        userId ? listUserTierMultipliers(userId) : Promise.resolve([]),
    ]);

    const topology = new ChannelGroupTopology(PLATFORM_TENANT_ID, groups);
    const scales = await customerScales(topology, overrides);
    const visibleModels: BrowserModelPricing[] = [];
    for (const model of models) {
        if (HIDDEN_MODELS.has(model.slug)) continue;
        const memberships = currentMemberships(model.upstream_map, topology);
        if (memberships.length === 0) continue;
        const latestPrices = new Map<string, (typeof model.prices)[number]>();
        for (const price of model.prices) {
            if (!latestPrices.has(price.tier)) latestPrices.set(price.tier, price);
        }
        const pricesByTier = Object.fromEntries(
            memberships.map((tier): [string, TierPricing | null] => {
                const price = latestPrices.get(tier);
                if (!price) return [tier, null];
                const scale = scales.get(tier) ?? 1;
                const publicDetails = parseTieredPricingDetails(price.billing_details);
                const details = publicDetails ? scaleTieredPricingDetails(publicDetails, scale) : null;
                const amount = (value: unknown): number | null =>
                    value == null ? null : scalePricingAmount(Number(value), scale);
                const pricing: TierPricing = {
                    input_cny_per_1m: details?.tiers[0].rates.input ?? amount(price.input_cny_per_1m),
                    output_cny_per_1m: details?.tiers[0].rates.output ?? amount(price.output_cny_per_1m),
                    per_image_cny: amount(price.per_image_cny),
                    ...(details ? { billing_details: details } : {}),
                };
                const hasPrice =
                    pricing.input_cny_per_1m !== null ||
                    pricing.output_cny_per_1m !== null ||
                    pricing.per_image_cny !== null;
                return [tier, hasPrice ? pricing : null];
            }),
        );
        visibleModels.push({ slug: model.slug, pricesByTier });
    }

    return {
        tiers: groups.map((group) => ({ key: group.key, label: group.display_name, isDefault: group.is_default })),
        models: visibleModels,
    };
}

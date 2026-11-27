import 'server-only';

import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { isPartnerTenant } from '@/lib/partner/group';

/**
 * 代理站点的价格显示口径。
 *
 * 公开目录价按平台 `GroupRatio` 算出，代理客户实际按代理零售率扣费。所以代理站要把每一档的
 * 公开价乘以 `零售率 ÷ 平台倍率`，并隐藏没对代理开放（没设零售率）的档次，否则客户在
 * /pricing、/models 看到平台价，扣费却是代理价。
 */
export interface PartnerPriceDisplay {
    tenantId: string;
    /** 平台档次 key → 价差倍率（零售率 ÷ 平台倍率）。 */
    scales: Map<string, number>;
    /** 平台档次 key → 代理零售率。 */
    retail: Map<string, number>;
    /** 对代理开放的平台档次 key。 */
    openTiers: Set<string>;
}

async function publicGroupRatios(): Promise<Record<string, number>> {
    try {
        const { getOption } = await import('@/lib/newapi/client');
        const raw: unknown = JSON.parse((await getOption('GroupRatio')) ?? '{}');
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const ratios: Record<string, number> = {};
        for (const [group, value] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) ratios[group] = value;
        }
        return ratios;
    } catch (err) {
        console.warn('[partner-display] GroupRatio lookup failed:', err);
        return {};
    }
}

/** 代理站显示口径；平台站点或配置不全时返回 null（保持原样）。 */
export async function loadPartnerPriceDisplay(tenantId: string | null | undefined): Promise<PartnerPriceDisplay | null> {
    if (!isPartnerTenant(tenantId)) return null;
    const [prices, tiers, ratios] = await Promise.all([
        prisma.partnerGroupPrice.findMany({
            where: { tenant_id: tenantId, retail_ratio: { not: null } },
            select: { group_key: true, retail_ratio: true },
        }),
        prisma.channelGroup.findMany({
            where: { tenant_id: PLATFORM_TENANT_ID, enabled: true },
            select: { key: true, newapi_group: true },
        }),
        publicGroupRatios(),
    ]);
    if (!prices.length) return { tenantId, scales: new Map(), retail: new Map(), openTiers: new Set() };
    const tierOf = new Map(tiers.map((tier) => [tier.key, tier.newapi_group]));
    const scales = new Map<string, number>();
    const retail = new Map<string, number>();
    const openTiers = new Set<string>();
    for (const price of prices) {
        const newapiGroup = tierOf.get(price.group_key);
        const publicRatio = newapiGroup ? ratios[newapiGroup] : undefined;
        if (!newapiGroup || publicRatio === undefined || price.retail_ratio == null) continue;
        const scale = Number(price.retail_ratio) / publicRatio;
        if (!Number.isFinite(scale) || scale <= 0) continue;
        scales.set(price.group_key, scale);
        retail.set(price.group_key, Number(price.retail_ratio));
        openTiers.add(price.group_key);
    }
    return { tenantId, scales, retail, openTiers };
}

/** 当前请求应使用哪个站点的价格口径：登录客户所属租户，否则按 Host 解析。 */
export async function resolveDisplayTenant(userTenantId: string | null, host: string | null): Promise<string> {
    if (userTenantId) return userTenantId;
    try {
        const { resolveTenantByHost } = await import('@/lib/tenant/resolve');
        return (await resolveTenantByHost(host)).id;
    } catch {
        return PLATFORM_TENANT_ID;
    }
}

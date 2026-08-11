import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { resolveAdmin } from '@/lib/admin/auth';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { getOption } from '@/lib/newapi/client';
import { CHAT_FX } from '@/lib/newapi/pricing-sync';
import { QUOTA_PER_USD, USD_TO_CNY_RATE } from '@/lib/newapi/quota-units';

export const runtime = 'nodejs';

function parseRatios(raw: string | null): Record<string, number> {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const ratios: Record<string, number> = {};
        for (const [group, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) ratios[group] = value;
        }
        return ratios;
    } catch {
        return {};
    }
}

/** Read-only context for the operator calculator; no price or new-api option is written here. */
export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const groups = await prisma.channelGroup.findMany({
        where: { ...tenantScope(admin), enabled: true },
        orderBy: [{ tier_level: 'asc' }, { key: 'asc' }],
        select: { key: true, display_name: true, newapi_group: true, is_default: true },
    });
    let groupRatioRaw: string | null = null;
    try {
        groupRatioRaw = await getOption('GroupRatio');
    } catch {
        // Keep the calculator usable with a manual GroupRatio when new-api is briefly unavailable.
    }
    const ratios = parseRatios(groupRatioRaw);

    return NextResponse.json({
        quota_per_usd: QUOTA_PER_USD,
        usd_to_cny_rate: USD_TO_CNY_RATE,
        chat_fx_cny_per_1m_quota: CHAT_FX,
        groups: groups.map((group) => ({
            key: group.key,
            display_name: group.display_name,
            newapi_group: group.newapi_group,
            is_default: group.is_default,
            group_ratio: ratios[group.newapi_group] ?? null,
        })),
    });
}

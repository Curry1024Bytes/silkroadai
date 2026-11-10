import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { resolveAdmin } from '@/lib/admin/auth';
import { PLATFORM_TENANT_ID, tenantScope } from '@/lib/admin/tenant-scope';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { getGroupRatios } from '@/lib/channel-group';
import {
    listUserTierMultipliers,
    saveUserTierMultiplier,
    UserTierMultiplierError,
} from '@/lib/newapi/user-tier-multiplier';

export const runtime = 'nodejs';

const RateOverrideSchema = z.object({
    tier_key: z.string().trim().min(1).max(100),
    multiplier: z.coerce.number().finite().positive().max(100),
    /** Set only after the operator has seen that this rate sells the tier below its recorded buy rate. */
    confirm_below_cost: z.boolean().optional(),
});

async function scopedCustomer(request: NextRequest, id: string) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return { admin: null, customer: null } as const;
    const customer = await prisma.user.findFirst({
        where: { id, ...tenantScope(admin) },
        select: { id: true, tenant_id: true, newapi_user_id: true },
    });
    return { admin, customer } as const;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const { admin, customer } = await scopedCustomer(request, id);
    if (!admin) return unauthorizedResponse(request);
    if (!customer) return NextResponse.json({ error: '客户不存在' }, { status: 404 });

    const [overrides, tiers, ratios, activeKeyCount, managed] = await Promise.all([
        listUserTierMultipliers(customer.id),
        prisma.channelGroup.findMany({
            where: { tenant_id: customer.tenant_id ?? PLATFORM_TENANT_ID, enabled: true },
            orderBy: { tier_level: 'asc' },
            select: { key: true, display_name: true, newapi_group: true, purchase_rate: true },
        }),
        getGroupRatios(),
        prisma.newApiToken.count({ where: { user_id: customer.id, status: 'active' } }),
        prisma.pricingBillingGroup.findMany({
            where: { unified_sale_ratio: { not: null } },
            select: { newapi_group: true },
        }),
    ]);
    const managedGroups = new Set(managed.map((row) => row.newapi_group));
    const overrideByTier = new Map(overrides.map((row) => [row.tier_key, row]));

    return NextResponse.json({
        overrides: overrides.map((row) => ({
            id: row.id,
            tier_key: row.tier_key,
            multiplier: Number(row.multiplier),
            managed_by_rules: row.managed_by_rules,
            synced_at: row.synced_at?.toISOString() ?? null,
            created_at: row.created_at.toISOString(),
            updated_at: row.updated_at.toISOString(),
        })),
        tiers: tiers.map((tier) => ({
            key: tier.key,
            display_name: tier.display_name,
            public_multiplier: ratios[tier.newapi_group] ?? null,
            purchase_rate: tier.purchase_rate === null ? null : Number(tier.purchase_rate),
            sale_rules_managed: managedGroups.has(tier.newapi_group),
            effective_multiplier: overrideByTier.has(tier.key)
                ? Number(overrideByTier.get(tier.key)!.multiplier)
                : (ratios[tier.newapi_group] ?? null),
        })),
        active_key_count: activeKeyCount,
    });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const { admin, customer } = await scopedCustomer(request, id);
    if (!admin) return unauthorizedResponse(request);
    if (!customer) return NextResponse.json({ error: '客户不存在' }, { status: 404 });

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: '请求格式无效' }, { status: 400 });
    }
    const parsed = RateOverrideSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: '档次和倍率格式无效', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }

    // A dedicated rate replaces the tier's sell rate outright. Below the recorded buy rate every request
    // loses money, so the operator must confirm it explicitly; nothing reaches new-api until then.
    const tier = await prisma.channelGroup.findFirst({
        where: { tenant_id: customer.tenant_id ?? PLATFORM_TENANT_ID, key: parsed.data.tier_key, enabled: true },
        select: { display_name: true, purchase_rate: true },
    });
    const purchaseRate = tier?.purchase_rate == null ? null : Number(tier.purchase_rate);
    if (purchaseRate !== null && parsed.data.multiplier < purchaseRate && parsed.data.confirm_below_cost !== true) {
        return NextResponse.json(
            {
                error: `倍率 ${parsed.data.multiplier} 低于「${tier!.display_name}」的进货率 ${purchaseRate}，按此价格每次调用都会亏损，需要确认后才能保存。`,
                code: 'below_cost',
                purchase_rate: purchaseRate,
                multiplier: parsed.data.multiplier,
            },
            { status: 409 },
        );
    }

    try {
        const override = await saveUserTierMultiplier({
            user: customer,
            tierKey: parsed.data.tier_key,
            multiplier: parsed.data.multiplier,
            createdBy: admin.user?.id ?? null,
        });
        return NextResponse.json({
            ok: true,
            override: {
                id: override.id,
                tier_key: override.tier_key,
                multiplier: Number(override.multiplier),
                synced_at: override.synced_at?.toISOString() ?? null,
                created_at: override.created_at.toISOString(),
                updated_at: override.updated_at.toISOString(),
            },
        });
    } catch (err) {
        if (err instanceof UserTierMultiplierError) {
            return NextResponse.json({ error: err.message }, { status: err.status });
        }
        console.error('[admin/rate-overrides] save failed', { customerId: id, err });
        return NextResponse.json({ error: '专属倍率同步失败' }, { status: 502 });
    }
}

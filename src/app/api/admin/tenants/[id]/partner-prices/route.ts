import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { partnerErrorResponse, PartnerPricingError } from '@/lib/partner/errors';
import { partnerUserGroup } from '@/lib/partner/group';
import { ratioSchema } from '@/lib/partner/ratio';
import { changePartnerPricing } from '@/lib/partner/pricing-sync';

export const runtime = 'nodejs';

/**
 * /api/admin/tenants/[id]/partner-prices — 超管给代理设批发率（P1 v2）。
 *
 * GET    — 该代理的批发率 / 零售率，以及平台启用中的档次（含进货率作对照）
 * POST   — 设批发率。批发率高于代理当前零售率时拒绝（规则 3）；每次改值追加一行批发率历史
 * DELETE ?group_key= — 收回分组。已定零售率的分组会立刻对代理客户隐藏
 */

const upsertSchema = z.object({
    group_key: z.string().min(1).max(80),
    wholesale_ratio: ratioSchema,
});

async function loadPartnerTenant(id: string): Promise<NextResponse | null> {
    if (id === PLATFORM_TENANT_ID) {
        return NextResponse.json({ error: 'platform_tenant', message: '平台主体无需设批发率' }, { status: 400 });
    }
    const tenant = await prisma.tenant.findUnique({ where: { id }, select: { id: true } });
    if (!tenant) return NextResponse.json({ error: 'not_found', message: '租户不存在' }, { status: 404 });
    return null;
}

function errorResponse(error: unknown) {
    const { body, status } = partnerErrorResponse(error);
    return NextResponse.json(body, { status });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const { id } = await params;
    const invalid = await loadPartnerTenant(id);
    if (invalid) return invalid;

    const [prices, channelGroups] = await Promise.all([
        prisma.partnerGroupPrice.findMany({ where: { tenant_id: id }, orderBy: { group_key: 'asc' } }),
        prisma.channelGroup.findMany({
            where: { tenant_id: PLATFORM_TENANT_ID, enabled: true },
            orderBy: { tier_level: 'asc' },
            select: { key: true, display_name: true, newapi_group: true, purchase_rate: true },
        }),
    ]);

    return NextResponse.json({
        partner_group: partnerUserGroup(id),
        prices: prices.map((price) => ({
            group_key: price.group_key,
            wholesale_ratio: Number(price.wholesale_ratio),
            retail_ratio: price.retail_ratio == null ? null : Number(price.retail_ratio),
            updated_at: price.updated_at,
        })),
        channelGroups: channelGroups.map((group) => ({
            key: group.key,
            display_name: group.display_name,
            newapi_group: group.newapi_group,
            purchase_rate: group.purchase_rate == null ? null : Number(group.purchase_rate),
        })),
    });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const { id } = await params;
    const invalid = await loadPartnerTenant(id);
    if (invalid) return invalid;

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = upsertSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten().fieldErrors }, { status: 400 });
    }
    const { group_key, wholesale_ratio } = parsed.data;
    const actorId = admin.user?.id ?? null;

    try {
        const price = await changePartnerPricing({
            tenantId: id,
            operation: 'admin-set-wholesale',
            change: async ({ current, billingGroups, groupRatio }) => {
                const newapiGroup = billingGroups.get(group_key);
                if (!newapiGroup) throw new PartnerPricingError('分组不存在或未启用。', 400);
                if (!Object.hasOwn(groupRatio, newapiGroup)) {
                    throw new PartnerPricingError(`new-api 的分组倍率里没有计费分组 ${newapiGroup}。`, 409);
                }
                const existing = current.find((row) => row.group_key === group_key);
                if (existing?.retail_ratio != null && wholesale_ratio > existing.retail_ratio) {
                    throw new PartnerPricingError(
                        `代理当前零售率 ${existing.retail_ratio} 低于新批发率 ${wholesale_ratio}，请先让代理调高零售率再保存。`,
                        409,
                    );
                }
                const next = existing
                    ? current.map((row) => (row.group_key === group_key ? { ...row, wholesale_ratio } : row))
                    : [...current, { group_key, wholesale_ratio, retail_ratio: null }];
                return {
                    next,
                    persist: () =>
                        prisma.$transaction(async (tx) => {
                            const row = await tx.partnerGroupPrice.upsert({
                                where: { tenant_id_group_key: { tenant_id: id, group_key } },
                                update: { wholesale_ratio, created_by: actorId },
                                create: { tenant_id: id, group_key, wholesale_ratio, created_by: actorId },
                            });
                            // 结算按日志时间取当时生效的批发率，所以每次改值都要留一行。
                            if (existing?.wholesale_ratio !== wholesale_ratio) {
                                await tx.partnerWholesaleRatioHistory.create({
                                    data: { tenant_id: id, group_key, wholesale_ratio, created_by: actorId },
                                });
                            }
                            return row;
                        }),
                };
            },
        });
        return NextResponse.json({
            price: {
                group_key: price.group_key,
                wholesale_ratio: Number(price.wholesale_ratio),
                retail_ratio: price.retail_ratio == null ? null : Number(price.retail_ratio),
                updated_at: price.updated_at,
            },
        });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const { id } = await params;
    const invalid = await loadPartnerTenant(id);
    if (invalid) return invalid;

    const group_key = new URL(request.url).searchParams.get('group_key');
    if (!group_key) return NextResponse.json({ error: 'invalid_input', message: 'group_key 参数必填' }, { status: 400 });

    try {
        await changePartnerPricing({
            tenantId: id,
            operation: 'admin-delete-wholesale',
            change: async ({ current }) => {
                const existing = current.find((row) => row.group_key === group_key);
                if (!existing) throw new PartnerPricingError('批发率记录不存在。', 404);
                const actorId = admin.user?.id ?? null;
                return {
                    next: current.filter((row) => row.group_key !== group_key),
                    persist: () =>
                        prisma.$transaction(async (tx) => {
                            await tx.partnerGroupPrice.delete({
                                where: { tenant_id_group_key: { tenant_id: id, group_key } },
                            });
                            // 关闭前的调用仍要按代理零售率结算，所以留一行 null 标记关闭时间。
                            if (existing.retail_ratio != null) {
                                await tx.partnerRetailRatioHistory.create({
                                    data: { tenant_id: id, group_key, retail_ratio: null, created_by: actorId },
                                });
                            }
                        }),
                };
            },
        });
        return NextResponse.json({ ok: true });
    } catch (error) {
        return errorResponse(error);
    }
}

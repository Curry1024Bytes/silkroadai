import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { partnerErrorResponse, PartnerPricingError } from '@/lib/partner/errors';
import { ratioSchema } from '@/lib/partner/ratio';
import { changePartnerPricing } from '@/lib/partner/pricing-sync';

export const runtime = 'nodejs';

/**
 * /api/partner/pricing — 代理给自己的客户定零售率（P1 v2）。
 *
 * GET — 平台开放给我的分组：拿货价（批发率）与我的零售率
 * PUT — { prices: [{ group_key, retail_ratio | null }] }。零售率不能低于拿货价；
 *       null 表示暂不开放该分组，客户看不到也用不了。保存后对所有客户立即生效。
 */

const saveSchema = z.object({
    prices: z
        .array(z.object({ group_key: z.string().min(1).max(80), retail_ratio: ratioSchema.nullable() }))
        .min(1)
        .max(100),
});

async function listPrices(tenantId: string) {
    const [prices, groups] = await Promise.all([
        prisma.partnerGroupPrice.findMany({ where: { tenant_id: tenantId }, orderBy: { group_key: 'asc' } }),
        prisma.channelGroup.findMany({
            where: { tenant_id: PLATFORM_TENANT_ID, enabled: true },
            select: { key: true, display_name: true },
        }),
    ]);
    const names = new Map(groups.map((group) => [group.key, group.display_name]));
    return prices.map((price) => ({
        group_key: price.group_key,
        display_name: names.get(price.group_key) ?? price.group_key,
        available: names.has(price.group_key),
        wholesale_ratio: Number(price.wholesale_ratio),
        retail_ratio: price.retail_ratio == null ? null : Number(price.retail_ratio),
    }));
}

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'staff');
    if (!admin) return unauthorizedResponse(request);
    if (!admin.tenant_id || admin.tenant_id === PLATFORM_TENANT_ID) {
        return NextResponse.json({ error: '仅白标代理可访问' }, { status: 403 });
    }
    return NextResponse.json({ prices: await listPrices(admin.tenant_id) });
}

export async function PUT(request: NextRequest) {
    const admin = await resolveAdmin(request, 'staff');
    if (!admin) return unauthorizedResponse(request);
    const tenantId = admin.tenant_id;
    if (!tenantId || tenantId === PLATFORM_TENANT_ID) {
        return NextResponse.json({ error: '仅白标代理可访问' }, { status: 403 });
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten().fieldErrors }, { status: 400 });
    }
    const updates = new Map(parsed.data.prices.map((price) => [price.group_key, price.retail_ratio]));
    if (updates.size !== parsed.data.prices.length) {
        return NextResponse.json({ error: 'invalid_input', message: '同一分组只能出现一次' }, { status: 400 });
    }

    try {
        await changePartnerPricing({
            tenantId,
            operation: 'partner-set-retail',
            change: async ({ current, billingGroups }) => {
                for (const [groupKey, retail] of updates) {
                    const row = current.find((item) => item.group_key === groupKey);
                    if (!row) throw new PartnerPricingError(`分组 ${groupKey} 没有向你开放。`, 400);
                    if (retail == null) continue;
                    if (!billingGroups.has(groupKey)) {
                        throw new PartnerPricingError(`分组 ${groupKey} 已停用，不能定价。`, 400);
                    }
                    if (retail < row.wholesale_ratio) {
                        throw new PartnerPricingError(
                            `分组 ${groupKey} 的零售率 ${retail} 低于拿货价 ${row.wholesale_ratio}。`,
                            400,
                        );
                    }
                }
                const next = current.map((row) =>
                    updates.has(row.group_key) ? { ...row, retail_ratio: updates.get(row.group_key) ?? null } : row,
                );
                const changed = next.filter((row, index) => row.retail_ratio !== current[index].retail_ratio);
                const actorId = admin.user?.id ?? null;
                return {
                    next,
                    persist: () =>
                        prisma.$transaction(
                            changed.flatMap((row) => [
                                prisma.partnerGroupPrice.update({
                                    where: { tenant_id_group_key: { tenant_id: tenantId, group_key: row.group_key } },
                                    data: { retail_ratio: row.retail_ratio },
                                }),
                                // 结算按日志时间核对零售率，改价和关闭都要留一行。
                                prisma.partnerRetailRatioHistory.create({
                                    data: {
                                        tenant_id: tenantId,
                                        group_key: row.group_key,
                                        retail_ratio: row.retail_ratio,
                                        created_by: actorId,
                                    },
                                }),
                            ]),
                        ),
                };
            },
        });
        return NextResponse.json({ prices: await listPrices(tenantId) });
    } catch (error) {
        const { body: errorBody, status } = partnerErrorResponse(error);
        return NextResponse.json(errorBody, { status });
    }
}

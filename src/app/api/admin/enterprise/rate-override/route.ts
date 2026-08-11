import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';

export const runtime = 'nodejs';

/**
 * POST /api/admin/enterprise/rate-override — 客户 per-模型议价折扣 upsert/删除(2026-08-11 重构)。
 *
 * 旧版是按 分辨率×含视 的绝对单价;现改为按 (客户, 渠道, 模型档) 的【折扣率】,优先级最高
 * (覆盖全局折扣与客户整体折扣,按模型隔离)。discount 传数字 = upsert;传 null = 删除(回落
 * 全局折扣 / 客户整体折扣)。守门:superadmin。⚠️ 只影响【下一次扣费】,已 billed 任务不重算。
 */
const schema = z.object({
    user_id: z.string().uuid(),
    region: z.enum(['cn', 'global', 'promax', 'volc']).default('cn'),
    variant: z
        .enum(['pro', 'fast', 'mini', '2.5', 'promax', 'promax-fast', 'promax-mini', 'promax-2.5'])
        .default('pro'),
    // 0.05~2(>1 = 上浮);null = 删除该 (客户,渠道,模型) 议价折扣
    discount: z.number().min(0.05).max(2).nullable(),
});

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { user_id, region, variant, discount } = parsed.data;

    if (discount === null) {
        await prisma.enterpriseModelDiscount.deleteMany({ where: { user_id, region, variant } });
        return NextResponse.json({ user_id, region, variant, discount: null, deleted: true });
    }
    await prisma.enterpriseModelDiscount.upsert({
        where: { user_id_region_variant: { user_id, region, variant } },
        create: { user_id, region, variant, discount },
        update: { discount },
    });
    return NextResponse.json({ user_id, region, variant, discount });
}

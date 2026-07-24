import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';

export const runtime = 'nodejs';

/**
 * POST /api/admin/enterprise/rate-override — 大客户议价费率 upsert/删除(P1,决策 Q4)。
 *
 * cny_per_m 传数字 = upsert 该 (user, resolution, has_video) 档的元/1M token;
 * 传 null = 删除覆盖(回落 cn-billing 默认挂牌)。守门:superadmin。
 * ⚠️ 只影响【下一次扣费】(轮询完成时算价);已 billed 任务不重算。
 */
const schema = z.object({
    user_id: z.string().uuid(),
    region: z.enum(['cn', 'global', 'promax']).default('cn'),
    variant: z.enum(['pro', 'fast', 'mini']).default('pro'),
    resolution: z.enum(['720p', '1080p', '4k']),
    has_video: z.boolean(),
    cny_per_m: z.number().positive().max(10_000).nullable(),
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
    const { user_id, region, variant, resolution, has_video, cny_per_m } = parsed.data;
    const where = {
        user_id_region_variant_resolution_has_video: { user_id, region, variant, resolution, has_video },
    };

    if (cny_per_m === null) {
        await prisma.enterpriseRateOverride.deleteMany({ where: { user_id, region, variant, resolution, has_video } });
        return NextResponse.json({ user_id, region, variant, resolution, has_video, cny_per_m: null, deleted: true });
    }
    await prisma.enterpriseRateOverride.upsert({
        where,
        create: { user_id, region, variant, resolution, has_video, cny_per_m },
        update: { cny_per_m },
    });
    return NextResponse.json({ user_id, region, variant, resolution, has_video, cny_per_m });
}

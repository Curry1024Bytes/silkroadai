import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { computeBatchCost, type BatchModelLike } from '@/lib/admin/batch-cost';

export const runtime = 'nodejs';

/**
 * POST /api/admin/pricing/batch-cost — P2.10 按家族(vendor)[+ 可选档次]批量填成本。
 *
 * 乙案:cost = 零售(chat→input / image→per_image) × (拿货ratio / 零售ratio)。
 * `dryRun:true` → 只返回预览(受影响每个 model×tier 的 现零售→算出 cost,无零售价标 skipped),不写库。
 * `dryRun:false` → 给每个 affected (model,tier) 插一条【新 CatalogPrice 版本行】(复制现有零售字段
 * + 新 cost_cny_per_1m + effective_from=now + created_by),不覆盖历史、不动零售价、不 sync new-api。
 *
 * 守门:cookie + superadmin(P6b §0 平台级管理锁;admin-platform-superadmin-lockdown 静态守护强制此串)
 * + tenantScope(只动本租户的目录模型)。
 */
const schema = z.object({
    vendor: z.string().min(1),
    tier: z.string().min(1).optional(),
    cost_ratio: z.number().positive(),
    retail_ratio: z.number().positive(),
    dryRun: z.boolean().optional().default(false),
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
    const { vendor, tier, cost_ratio, retail_ratio, dryRun } = parsed.data;

    // 该 vendor 的本租户目录模型 + 各自版本化价(effective_from DESC → 每档当前价 = 第一行)。
    const models = await prisma.catalogModel.findMany({
        where: { vendor, ...tenantScope(admin) },
        orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
        include: { prices: { orderBy: { effective_from: 'desc' } } },
    });

    const result = computeBatchCost(models as unknown as BatchModelLike[], {
        costRatio: cost_ratio,
        retailRatio: retail_ratio,
        tier: tier ?? null,
    });

    // 预览:不写库。
    if (dryRun) {
        return NextResponse.json({ dryRun: true, vendor, tier: tier ?? null, written: 0, ...result });
    }

    // Apply:每个 affected (model,tier) 插新版本行(复制零售 + 新 cost;effective_from 默认 now()
    // → 比被复制的旧行新 = 版本追加,绝不 UPDATE/覆盖历史)。
    const toWrite = result.rows.filter((r) => !r.skipped && r.newCost !== null && r.copy);
    let written = 0;
    if (toWrite.length > 0) {
        const created = await prisma.catalogPrice.createMany({
            data: toWrite.map((r) => ({
                model_id: r.model_id,
                tier: r.tier,
                input_cny_per_1m: r.copy!.input_cny_per_1m,
                output_cny_per_1m: r.copy!.output_cny_per_1m,
                per_image_cny: r.copy!.per_image_cny,
                cost_cny_per_1m: r.newCost,
                created_by: admin.user?.id ?? null,
            })),
        });
        written = created.count;
    }

    return NextResponse.json({ dryRun: false, vendor, tier: tier ?? null, written, ...result });
}

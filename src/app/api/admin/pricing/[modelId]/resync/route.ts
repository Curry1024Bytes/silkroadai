import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { syncModelPriceToNewApi, type UpstreamMap } from '@/lib/newapi/pricing-sync';

export const runtime = 'nodejs';

/**
 * POST /api/admin/pricing/[modelId]/resync — 重试同步。
 * 不改价,把该模型每个档次的【当前价】(最新 effective_from)重新 sync 到 new-api。
 * 用于上次保存时 sync 失败后的「重新同步」按钮。
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ modelId: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const { modelId } = await params;
    const model = await prisma.catalogModel.findFirst({
        where: { id: modelId, ...tenantScope(admin) },
        include: { prices: { orderBy: { effective_from: 'desc' } } },
    });
    if (!model) return NextResponse.json({ error: '模型不存在' }, { status: 404 });

    // 每个档次取第一行(最新 = 当前价)。
    const currentByTier = new Map<string, (typeof model.prices)[number]>();
    for (const p of model.prices) {
        if (!currentByTier.has(p.tier)) currentByTier.set(p.tier, p);
    }
    if (currentByTier.size === 0) {
        return NextResponse.json({ error: '该模型还没有任何价格,无法同步' }, { status: 400 });
    }

    const results: { tier: string; sync: Awaited<ReturnType<typeof syncModelPriceToNewApi>> }[] = [];
    for (const [tier, p] of currentByTier) {
        const sync = await syncModelPriceToNewApi(model.upstream_map as unknown as UpstreamMap, {
            tier,
            input_cny_per_1m: p.input_cny_per_1m != null ? Number(p.input_cny_per_1m) : null,
            output_cny_per_1m: p.output_cny_per_1m != null ? Number(p.output_cny_per_1m) : null,
            per_image_cny: p.per_image_cny != null ? Number(p.per_image_cny) : null,
        });
        results.push({ tier, sync });
    }
    return NextResponse.json({ results });
}

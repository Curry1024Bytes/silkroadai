import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import {
    syncModelPriceToNewApi,
    resolveImageModelPrice,
    resolveChatTierPrice,
    getTierGroupRatio,
    type UpstreamMap,
} from '@/lib/newapi/pricing-sync';

export const runtime = 'nodejs';

/**
 * POST /api/admin/pricing/[modelId]/resync — 重试同步。
 * 不改价,把该模型【当前价】(每档最新 effective_from)重新 sync 到 new-api。
 * 用于上次保存时 sync 失败后的「重新同步」按钮。
 *
 * chat(P2.9)+ 图片(P2.8)都走 new-api【全局 option】(ModelRatio/CompletionRatio、
 * ModelPrice),**按模型名、不分渠道/档次** → 每类只 sync 一次,用默认档(is_default)的价;
 * 多档填了不同价时 warn(架构限制,见 pricing-sync.ts;真分档留 P4c)。
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

    const upstreamMap = model.upstream_map as unknown as UpstreamMap;
    const current = [...currentByTier.values()];
    // chat:有 in/out 价 → 全局 ModelRatio + CompletionRatio(P2.9)。
    const chatPrices = current.filter((p) => p.input_cny_per_1m != null && p.output_cny_per_1m != null);
    // image:只有 per_image → 全局 ModelPrice(P2.8)。
    const imagePrices = current.filter(
        (p) => p.per_image_cny != null && p.input_cny_per_1m == null && p.output_cny_per_1m == null,
    );

    // 默认档 key(is_default,通常 pool):全局 option 不分档 → 每类用默认档值同步一次。读一次共用。
    const defaultTier =
        chatPrices.length > 0 || imagePrices.length > 0
            ? ((
                  await prisma.channelGroup.findFirst({
                      where: { ...tenantScope(admin), is_default: true },
                      select: { key: true },
                  })
              )?.key ?? 'pool')
            : 'pool';

    // GR 原生语义:各档组倍率(用于一致性 warn —— 各档目录价应满足 ¥ ∝ 组倍率)。
    // 解析失败的档留空 → resolve* 对该档退回逐字比价/直接点名,不阻塞同步。
    const ratiosByTier: Record<string, number> = {};
    for (const t of new Set(current.map((p) => p.tier))) {
        try {
            ratiosByTier[t] = await getTierGroupRatio(t);
        } catch {
            /* 未登记档/GroupRatio 缺组 → 留空 */
        }
    }

    const results: { tier: string; sync: Awaited<ReturnType<typeof syncModelPriceToNewApi>> }[] = [];

    if (chatPrices.length > 0) {
        const picked = resolveChatTierPrice(
            chatPrices.map((p) => ({
                tier: p.tier,
                input_cny_per_1m: Number(p.input_cny_per_1m),
                output_cny_per_1m: Number(p.output_cny_per_1m),
            })),
            defaultTier,
            ratiosByTier,
        );
        const sync = await syncModelPriceToNewApi(upstreamMap, {
            tier: picked.tier,
            input_cny_per_1m: picked.input_cny_per_1m,
            output_cny_per_1m: picked.output_cny_per_1m,
            per_image_cny: null,
        });
        results.push({ tier: picked.tier, sync: picked.warn ? { ...sync, warn: picked.warn } : sync });
    }

    if (imagePrices.length > 0) {
        const picked = resolveImageModelPrice(
            imagePrices.map((p) => ({ tier: p.tier, per_image_cny: Number(p.per_image_cny) })),
            defaultTier,
            ratiosByTier,
        );
        const sync = await syncModelPriceToNewApi(upstreamMap, {
            tier: picked.tier,
            input_cny_per_1m: null,
            output_cny_per_1m: null,
            per_image_cny: picked.per_image_cny,
        });
        results.push({ tier: picked.tier, sync: picked.warn ? { ...sync, warn: picked.warn } : sync });
    }

    return NextResponse.json({ results });
}

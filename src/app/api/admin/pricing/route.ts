import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { syncModelPriceToNewApi, CHAT_FX, IMAGE_FX, type UpstreamMap } from '@/lib/newapi/pricing-sync';
import { getOption } from '@/lib/newapi/client';

export const runtime = 'nodejs';

/**
 * GET /api/admin/pricing — 列出本租户所有目录模型 + 其价格行(版本,effective_from
 * 倒序)。客户端从每个 (model, tier) 的第一行得"当前价",其余即改价历史时间线。
 */
export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const models = await prisma.catalogModel.findMany({
        where: { ...tenantScope(admin) },
        orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
        include: { prices: { orderBy: { effective_from: 'desc' } } },
    });

    // GR 原生语义(2026-07-20):编辑表单的实时换算预览需要 (FX, 各档组倍率)。best-effort ——
    // new-api 不可达时为 null,页面隐藏预览即可,不影响列表/改价本身。
    let pricing_context: {
        chat_fx: number;
        image_fx: number;
        group_ratio_by_tier: Record<string, number>;
    } | null = null;
    try {
        const [cgs, raw] = await Promise.all([
            prisma.channelGroup.findMany({
                where: { ...tenantScope(admin) },
                select: { key: true, newapi_group: true },
            }),
            getOption('GroupRatio'),
        ]);
        const dict = raw ? (JSON.parse(raw) as Record<string, number>) : {};
        const byTier: Record<string, number> = {};
        for (const g of cgs) {
            const r = dict[g.newapi_group];
            if (typeof r === 'number' && Number.isFinite(r) && r > 0) byTier[g.key] = r;
        }
        pricing_context = { chat_fx: CHAT_FX, image_fx: IMAGE_FX, group_ratio_by_tier: byTier };
    } catch {
        pricing_context = null;
    }

    return NextResponse.json({ models, pricing_context });
}

const changePriceSchema = z
    .object({
        model_id: z.string().uuid(),
        // P2.7: tier defaults to 'pool' (catch-all), never 'default' — the page always sends the
        // row's real tier (pool/official), but no fallback path should ever write a 'default' row.
        tier: z.string().min(1).default('pool'),
        input_cny_per_1m: z.number().nonnegative().nullable().optional(),
        output_cny_per_1m: z.number().nonnegative().nullable().optional(),
        per_image_cny: z.number().nonnegative().nullable().optional(),
        cost_cny_per_1m: z.number().nonnegative().nullable().optional(),
    })
    .refine((d) => (d.input_cny_per_1m != null && d.output_cny_per_1m != null) || d.per_image_cny != null, {
        message: '需要 input+output 价(文本/对话模型)或 per_image 价(图片模型)',
    });

/**
 * POST /api/admin/pricing — 改价。
 * 插一条新的 CatalogPrice 版本行(不覆盖旧行 → 历史可追溯/复算),然后 best-effort
 * 把新价 sync 到 new-api(决策①:一上线即生效)。sync 失败不影响价格落库 —— 价格
 * 以 portal DB 为事实源,sync 状态回前端,可「重新同步」。
 */
export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = changePriceSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const d = parsed.data;

    // 模型必须属于本租户。
    const model = await prisma.catalogModel.findFirst({ where: { id: d.model_id, ...tenantScope(admin) } });
    if (!model) return NextResponse.json({ error: '模型不存在' }, { status: 404 });

    // 插版本行(effective_from 默认 now;created_by = 改价的 admin,break-glass 为 null)。
    const price = await prisma.catalogPrice.create({
        data: {
            model_id: model.id,
            tier: d.tier,
            input_cny_per_1m: d.input_cny_per_1m ?? null,
            output_cny_per_1m: d.output_cny_per_1m ?? null,
            per_image_cny: d.per_image_cny ?? null,
            cost_cny_per_1m: d.cost_cny_per_1m ?? null,
            created_by: admin.user?.id ?? null,
        },
    });

    // best-effort sync 到 new-api。chat → 全局 ModelRatio + CompletionRatio(P2.9;旧的 PUT
    // 渠道 model_ratio 被 new-api 静默丢弃);图片 → 全局 ModelPrice(P2.8)。两者都按模型名、
    // 不分档。本路由是单档改价,按【本次编辑档】的值即时同步;全局价不分档(默认档归一 + 多档
    // warn 在「重新同步」里统一处理)。⚠️ 保存即改真实计费 —— operator 须先核对目录价。
    const sync = await syncModelPriceToNewApi(model.upstream_map as unknown as UpstreamMap, {
        tier: d.tier,
        input_cny_per_1m: d.input_cny_per_1m ?? null,
        output_cny_per_1m: d.output_cny_per_1m ?? null,
        per_image_cny: d.per_image_cny ?? null,
    });

    return NextResponse.json({ price, sync }, { status: 201 });
}

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { syncModelPriceToNewApi, type UpstreamMap } from '@/lib/newapi/pricing-sync';

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
    return NextResponse.json({ models });
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

    // best-effort sync 到 new-api。chat → per-channel model_ratio;图片(填了 per_image_cny)
    // → 全局 ModelPrice(P2.8 Part B,之前走 skip)。本路由是单档改价,图片按【本次编辑档】
    // 的值即时同步;全局 ModelPrice 不分档(默认档归一 + 多档 warn 在「重新同步」里统一处理)。
    const sync = await syncModelPriceToNewApi(model.upstream_map as unknown as UpstreamMap, {
        tier: d.tier,
        input_cny_per_1m: d.input_cny_per_1m ?? null,
        output_cny_per_1m: d.output_cny_per_1m ?? null,
        per_image_cny: d.per_image_cny ?? null,
    });

    return NextResponse.json({ price, sync }, { status: 201 });
}

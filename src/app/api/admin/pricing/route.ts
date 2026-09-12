import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { CHAT_FX, IMAGE_FX } from '@/lib/newapi/pricing-sync';
import { getOption } from '@/lib/newapi/client';
import {
    enqueuePricingPublish,
    previewPricingPublish,
    pricingPublishInputSchema,
    pricingPublishErrorResponse,
    listPricingJobs,
} from '@/lib/admin/pricing-publish';

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
                where: { ...tenantScope(admin), enabled: true },
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

    return NextResponse.json({ models, pricing_context, publish_jobs: await listPricingJobs(admin) });
}

/** A preview never writes. Confirming it stores a durable intent and returns
 * 202; the background publisher alone may verify and activate CatalogPrice. */
export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input', message: '请求格式无效。' }, { status: 400 });
    }
    const action = z
        .object({ action: z.enum(['preview', 'publish']), preview_token: z.string().max(200).optional() })
        .safeParse(body);
    if (!action.success) {
        return NextResponse.json(
            {
                error: 'pricing_preview_required',
                message: '请刷新定价页，先预览价格变化，再确认发布。旧的直接保存方式已停用。',
            },
            { status: 409 },
        );
    }
    const input = pricingPublishInputSchema.safeParse(body);
    if (!input.success)
        return NextResponse.json(
            { error: 'invalid_input', message: input.error.issues[0]?.message ?? '价格格式无效。' },
            { status: 400 },
        );
    try {
        if (action.data.action === 'preview')
            return NextResponse.json({ preview: await previewPricingPublish(input.data, admin) });
        if (!action.data.preview_token)
            return NextResponse.json(
                { error: 'pricing_preview_required', message: '请先预览价格变化。' },
                { status: 400 },
            );
        const job = await enqueuePricingPublish(input.data, action.data.preview_token, admin);
        return NextResponse.json({ job }, { status: 202 });
    } catch (error) {
        const response = pricingPublishErrorResponse(error);
        return NextResponse.json(response.body, { status: response.status });
    }
}

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';

export const runtime = 'nodejs';

const upstreamMapSchema = z.record(
    z.string().min(1),
    z.object({
        channel_id: z.number().int(),
        upstream_model: z.string().min(1),
    }),
);

const updateModelSchema = z.object({
    display_name: z.string().min(1).max(100).optional(),
    vendor: z.string().min(1).max(50).optional(),
    modality: z.enum(['chat', 'image', 'embedding']).optional(),
    context_window: z.number().int().positive().nullable().optional(),
    enabled: z.boolean().optional(),
    sort_order: z.number().int().min(0).optional(),
    upstream_map: upstreamMapSchema.optional(),
    // slug 是客户调用名 + 计费锚点,改了会断历史价归属;P2 不允许改 slug。
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;
    const model = await prisma.catalogModel.findFirst({
        where: { id, ...tenantScope(admin) },
        include: { prices: { orderBy: { effective_from: 'desc' } } },
    });
    if (!model) return NextResponse.json({ error: '模型不存在' }, { status: 404 });
    return NextResponse.json({ model });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = updateModelSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }

    const existing = await prisma.catalogModel.findFirst({ where: { id, ...tenantScope(admin) } });
    if (!existing) return NextResponse.json({ error: '模型不存在' }, { status: 404 });

    const model = await prisma.catalogModel.update({
        where: { id: existing.id },
        data: parsed.data,
    });
    return NextResponse.json({ model });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;
    const existing = await prisma.catalogModel.findFirst({ where: { id, ...tenantScope(admin) } });
    if (!existing) return NextResponse.json({ error: '模型不存在' }, { status: 404 });

    // CatalogPrice 随 onDelete: Cascade 一并删除。new-api 渠道的 model_ratio 不动
    // (删 portal 目录条目不应改上游计费 —— 如需下架,改 enabled / 调价)。
    await prisma.catalogModel.delete({ where: { id: existing.id } });
    return NextResponse.json({ success: true });
}

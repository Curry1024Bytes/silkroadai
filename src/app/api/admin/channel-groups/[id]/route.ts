import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';

export const runtime = 'nodejs';

// key 是档次标识(NewApiToken.tier 引用它),改了会让已建 key 的档次标签悬空 —
// P3 不允许改 key(要换标识就新建一个档次)。其余字段可改。
const updateSchema = z.object({
    display_name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    newapi_group: z.string().trim().min(1).max(50).optional(),
    tier_level: z.number().int().min(0).optional(),
    enabled: z.boolean().optional(),
    is_default: z.boolean().optional(),
    newapi_channel_ids: z.array(z.number().int()).optional(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;
    const group = await prisma.channelGroup.findFirst({ where: { id, ...tenantScope(admin) } });
    if (!group) return NextResponse.json({ error: '渠道分组不存在' }, { status: 404 });
    return NextResponse.json({ group });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }

    const existing = await prisma.channelGroup.findFirst({ where: { id, ...tenantScope(admin) } });
    if (!existing) return NextResponse.json({ error: '渠道分组不存在' }, { status: 404 });

    // 单一默认档不变式:把本档设为默认时,清掉同租户其它默认。
    const group = await prisma.$transaction(async (tx) => {
        if (parsed.data.is_default === true) {
            await tx.channelGroup.updateMany({
                where: { tenant_id: existing.tenant_id, NOT: { id: existing.id } },
                data: { is_default: false },
            });
        }
        return tx.channelGroup.update({ where: { id: existing.id }, data: parsed.data });
    });
    return NextResponse.json({ group });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;
    const existing = await prisma.channelGroup.findFirst({ where: { id, ...tenantScope(admin) } });
    if (!existing) return NextResponse.json({ error: '渠道分组不存在' }, { status: 404 });

    // 注:删档次不影响已建 token(其 new-api group 已下发、照常工作);只是新建
    // key 不能再选该档,且列表里该 tier 的标签回退显示原 key。已建 token 不动。
    await prisma.channelGroup.delete({ where: { id: existing.id } });
    return NextResponse.json({ success: true });
}

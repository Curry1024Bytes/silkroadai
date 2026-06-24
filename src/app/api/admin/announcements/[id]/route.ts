import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { announcementInputSchema } from '@/lib/announcements/validation';

export const runtime = 'nodejs';

/**
 * /api/admin/announcements/[id] — 单条公告 更新(PUT,整体替换)/ 删除(DELETE)。
 * 仅 superadmin。PUT 用与 POST 同一 schema,因为 admin 编辑 modal 永远提交完整
 * 对象 —— 不做 partial update,语义更可预测(上/下线也走 PUT 改 is_active)。
 */

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: Ctx) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = announcementInputSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }

    const existing = await prisma.announcement.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const d = parsed.data;
    const announcement = await prisma.announcement.update({
        where: { id },
        data: {
            title: d.title,
            body: d.body,
            level: d.level,
            link_url: d.link_url,
            link_label: d.link_label,
            is_active: d.is_active,
        },
    });
    return NextResponse.json({ announcement });
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;
    try {
        await prisma.announcement.delete({ where: { id } });
    } catch {
        // delete 命中不存在的 id → Prisma 抛 P2025;统一回 404。
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
}

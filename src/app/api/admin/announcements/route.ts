import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { announcementInputSchema } from '@/lib/announcements/validation';

export const runtime = 'nodejs';

/**
 * /api/admin/announcements — 运营公告 CRUD(列表 + 新建)。**仅 superadmin**:
 * 发全站消息是平台超管职权(对齐 P6b 平台锁定),partner admin 不能发。初版只发
 * 全局公告(tenant_id 留空 = null);白标 partner 自有公告留 P6+。
 */

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const announcements = await prisma.announcement.findMany({ orderBy: { created_at: 'desc' } });
    return NextResponse.json({ announcements });
}

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

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
    const d = parsed.data;
    const announcement = await prisma.announcement.create({
        data: {
            title: d.title,
            body: d.body,
            level: d.level,
            link_url: d.link_url,
            link_label: d.link_label,
            is_active: d.is_active,
            // tenant_id 留空(null=全局);白标 partner 自有公告 P6+。
        },
    });
    return NextResponse.json({ announcement }, { status: 201 });
}

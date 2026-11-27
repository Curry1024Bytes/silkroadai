import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

export const runtime = 'nodejs';

/** GET /api/partner/customers — 该代理租户下的客户列表（分页） */
export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'staff');
    if (!admin) return unauthorizedResponse(request);
    if (!admin.tenant_id || admin.tenant_id === PLATFORM_TENANT_ID) {
        return NextResponse.json({ error: '仅白标代理可访问' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('page_size') ?? '20', 10)));
    const skip = (page - 1) * pageSize;

    const [users, total] = await Promise.all([
        prisma.user.findMany({
            where: { tenant_id: admin.tenant_id },
            select: {
                id: true,
                email: true,
                newapi_username: true,
                nickname: true,
                role: true,
                status: true,
                created_at: true,
                newapi_user_id: true,
            },
            orderBy: { created_at: 'desc' },
            skip,
            take: pageSize,
        }),
        prisma.user.count({ where: { tenant_id: admin.tenant_id } }),
    ]);

    return NextResponse.json({ users, total, page, pageSize });
}

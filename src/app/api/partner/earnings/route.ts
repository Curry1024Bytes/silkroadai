import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

export const runtime = 'nodejs';

/** GET /api/partner/earnings — 结算明细（分页，支持 model/from/to 过滤） */
export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'staff');
    if (!admin) return unauthorizedResponse(request);
    if (!admin.tenant_id || admin.tenant_id === PLATFORM_TENANT_ID) {
        return NextResponse.json({ error: '仅白标代理可访问' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
    const pageSize = Math.min(200, Math.max(1, parseInt(searchParams.get('page_size') ?? '50', 10)));
    const skip = (page - 1) * pageSize;
    const model = searchParams.get('model') ?? undefined;
    const from = searchParams.get('from') ? new Date(searchParams.get('from')!) : undefined;
    const to = searchParams.get('to') ? new Date(searchParams.get('to')!) : undefined;

    const where = {
        tenant_id: admin.tenant_id,
        ...(model ? { model_slug: model } : {}),
        ...(from || to
            ? {
                  settled_at: {
                      ...(from ? { gte: from } : {}),
                      ...(to ? { lte: to } : {}),
                  },
              }
            : {}),
    };

    const [earnings, total] = await Promise.all([
        prisma.partnerEarning.findMany({
            where,
            orderBy: { settled_at: 'desc' },
            skip,
            take: pageSize,
        }),
        prisma.partnerEarning.count({ where }),
    ]);

    return NextResponse.json({ earnings, total, page, pageSize });
}

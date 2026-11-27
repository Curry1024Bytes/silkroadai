import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

export const runtime = 'nodejs';

/** GET /api/partner/wholesale — 代理只读：平台给我的拿货价 */
export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'staff');
    if (!admin) return unauthorizedResponse(request);
    if (!admin.tenant_id || admin.tenant_id === PLATFORM_TENANT_ID) {
        return NextResponse.json({ error: '仅白标代理可访问' }, { status: 403 });
    }

    const prices = await prisma.partnerGroupPrice.findMany({
        where: { tenant_id: admin.tenant_id },
        orderBy: { group_key: 'asc' },
    });

    return NextResponse.json({ prices });
}

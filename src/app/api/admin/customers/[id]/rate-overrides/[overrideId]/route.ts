import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { disableUserTierMultiplier, UserTierMultiplierError } from '@/lib/newapi/user-tier-multiplier';

export const runtime = 'nodejs';

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; overrideId: string }> },
) {
    const { id, overrideId } = await params;
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    const customer = await prisma.user.findFirst({
        where: { id, ...tenantScope(admin) },
        select: { id: true, newapi_user_id: true },
    });
    if (!customer) return NextResponse.json({ error: '客户不存在' }, { status: 404 });

    try {
        await disableUserTierMultiplier({ user: customer, overrideId });
        return NextResponse.json({ ok: true, id: overrideId });
    } catch (err) {
        if (err instanceof UserTierMultiplierError) {
            return NextResponse.json({ error: err.message }, { status: err.status });
        }
        console.error('[admin/rate-overrides] delete failed', { customerId: id, overrideId, err });
        return NextResponse.json({ error: '专属倍率同步失败' }, { status: 502 });
    }
}

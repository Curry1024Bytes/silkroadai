import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

export const runtime = 'nodejs';

/** GET /api/partner/wallet — 代理钱包（懒建）+ 最近提现申请 */
export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'staff');
    if (!admin) return unauthorizedResponse(request);
    if (!admin.tenant_id || admin.tenant_id === PLATFORM_TENANT_ID) {
        return NextResponse.json({ error: '仅白标代理可访问' }, { status: 403 });
    }

    const wallet = await prisma.partnerWallet.upsert({
        where: { tenant_id: admin.tenant_id },
        update: {},
        create: { tenant_id: admin.tenant_id },
    });
    const withdrawals = await prisma.partnerWithdrawal.findMany({
        where: { tenant_id: admin.tenant_id },
        orderBy: { created_at: 'desc' },
        take: 20,
        select: { id: true, amount_cny: true, status: true, admin_note: true, created_at: true, processed_at: true },
    });
    return NextResponse.json({ wallet, withdrawals });
}

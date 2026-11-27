import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';

export const runtime = 'nodejs';

/** GET /api/admin/partner-withdrawals?status=pending|paid|rejected|all — 代理提现申请（超管） */
const statusSchema = z.enum(['pending', 'paid', 'rejected', 'all']);

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const parsed = statusSchema.safeParse(new URL(request.url).searchParams.get('status') ?? 'pending');
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_input', message: 'status 无效' }, { status: 400 });
    }
    const status = parsed.data;

    const withdrawals = await prisma.partnerWithdrawal.findMany({
        where: status === 'all' ? {} : { status },
        orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
        take: 200,
        select: {
            id: true,
            tenant_id: true,
            amount_cny: true,
            status: true,
            note: true,
            admin_note: true,
            created_at: true,
            processed_at: true,
            tenant: { select: { brand_name: true, slug: true } },
        },
    });
    return NextResponse.json({ withdrawals });
}

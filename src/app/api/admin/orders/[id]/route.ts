import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { resolveLocale } from '@/lib/locale';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;
    const locale = resolveLocale(request.nextUrl.searchParams.get('lang'));

    // P1: findUnique → findFirst so tenantScope can join the where (superadmin
    // → {} → identical to a by-id lookup; partner admin → 只看本租户的订单).
    const order = await prisma.order.findFirst({
        where: { id, ...tenantScope(admin) },
        include: {
            auditLogs: {
                orderBy: { createdAt: 'desc' },
            },
        },
    });

    if (!order) {
        return NextResponse.json({ error: locale === 'en' ? 'Order not found' : '订单不存在' }, { status: 404 });
    }

    return NextResponse.json({
        ...order,
        amount: Number(order.amount),
        payAmount: order.payAmount ? Number(order.payAmount) : null,
        feeRate: order.feeRate ? Number(order.feeRate) : null,
        refundAmount: order.refundAmount ? Number(order.refundAmount) : null,
    });
}

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyAdminToken, unauthorizedResponse } from '@/lib/admin-auth';
import { resolveLocale } from '@/lib/locale';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!(await verifyAdminToken(request))) return unauthorizedResponse(request);

    const { id } = await params;
    const locale = resolveLocale(request.nextUrl.searchParams.get('lang'));

    const order = await prisma.order.findUnique({
        where: { id },
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

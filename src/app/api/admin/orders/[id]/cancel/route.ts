import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminToken, unauthorizedResponse } from '@/lib/admin-auth';
import { resolveLocale } from '@/lib/locale';
import { adminCancelOrder } from '@/lib/order/service';
import { handleApiError } from '@/lib/utils/api';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!(await verifyAdminToken(request))) return unauthorizedResponse(request);

    const locale = resolveLocale(request.nextUrl.searchParams.get('lang'));

    try {
        const { id } = await params;
        const outcome = await adminCancelOrder(id, locale);
        if (outcome === 'already_paid') {
            return NextResponse.json({
                success: true,
                status: 'PAID',
                message: locale === 'en' ? 'Order has already been paid' : '订单已支付完成',
            });
        }
        return NextResponse.json({ success: true });
    } catch (error) {
        return handleApiError(error, locale === 'en' ? 'Cancel order failed' : '取消订单失败', request);
    }
}

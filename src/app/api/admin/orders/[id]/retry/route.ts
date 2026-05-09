import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminToken, unauthorizedResponse } from '@/lib/admin-auth';
import { resolveLocale } from '@/lib/locale';
import { retryRecharge } from '@/lib/order/service';
import { handleApiError } from '@/lib/utils/api';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!(await verifyAdminToken(request))) return unauthorizedResponse(request);

    const locale = resolveLocale(request.nextUrl.searchParams.get('lang'));

    try {
        const { id } = await params;
        await retryRecharge(id, locale);
        return NextResponse.json({ success: true });
    } catch (error) {
        return handleApiError(error, locale === 'en' ? 'Recharge retry failed' : '重试充值失败', request);
    }
}

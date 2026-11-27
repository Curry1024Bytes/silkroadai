import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { partnerErrorResponse, PartnerPricingError } from '@/lib/partner/errors';

export const runtime = 'nodejs';

const processSchema = z.object({
    action: z.enum(['paid', 'reject']),
    admin_note: z.string().max(500).optional(),
});

/**
 * POST /api/admin/partner-withdrawals/[id] — 标记已打款或驳回（超管）。
 * 状态从 pending 条件更新，重复处理返回 409；打款只扣冻结，驳回把冻结退回可用余额。
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const { id } = await params;

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = processSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten().fieldErrors }, { status: 400 });
    }
    const { action, admin_note } = parsed.data;

    try {
        const result = await prisma.$transaction(async (tx) => {
            const withdrawal = await tx.partnerWithdrawal.findUnique({
                where: { id },
                select: { id: true, tenant_id: true, amount_cny: true, status: true },
            });
            if (!withdrawal) throw new PartnerPricingError('提现申请不存在。', 404);
            const claimed = await tx.partnerWithdrawal.updateMany({
                where: { id, status: 'pending' },
                data: {
                    status: action === 'paid' ? 'paid' : 'rejected',
                    admin_note: admin_note?.trim() || null,
                    processed_by: admin.user?.id ?? null,
                    processed_at: new Date(),
                },
            });
            if (claimed.count !== 1) throw new PartnerPricingError('该申请已被处理。', 409);
            const wallet = await tx.partnerWallet.update({
                where: { tenant_id: withdrawal.tenant_id },
                data: {
                    pending_cny: { decrement: withdrawal.amount_cny },
                    ...(action === 'reject' ? { balance_cny: { increment: withdrawal.amount_cny } } : {}),
                },
            });
            await tx.adminAuditLog.create({
                data: {
                    admin_user_id: admin.user?.id ?? null,
                    admin_email: admin.user?.email ?? null,
                    level: admin.viaBreakGlass ? 'break_glass' : 'super',
                    action: `partner_withdrawal_${action}`,
                    method: 'POST',
                    path: `/api/admin/partner-withdrawals/${id}`,
                    target: withdrawal.tenant_id,
                    params: JSON.stringify({ id, action, amount_cny: withdrawal.amount_cny.toString() }),
                },
            });
            return { withdrawal: { ...withdrawal, status: action === 'paid' ? 'paid' : 'rejected' }, wallet };
        });
        return NextResponse.json(result);
    } catch (error) {
        const { body: errorBody, status } = partnerErrorResponse(error);
        return NextResponse.json(errorBody, { status });
    }
}

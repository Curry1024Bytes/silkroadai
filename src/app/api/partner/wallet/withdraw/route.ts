import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { partnerErrorResponse, PartnerPricingError } from '@/lib/partner/errors';

export const runtime = 'nodejs';

const withdrawSchema = z.object({
    amount_cny: z.number().positive().max(1_000_000),
    note: z.string().max(500).optional(),
});

/**
 * POST /api/partner/wallet/withdraw — 代理提现申请。
 * 余额检查和冻结在一条条件更新里完成（余额不足时更新 0 行），并写下提现记录。
 * 打款由超管在后台标记；驳回时冻结金额退回可用余额。
 */
export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'staff');
    if (!admin) return unauthorizedResponse(request);
    const tenantId = admin.tenant_id;
    if (!tenantId || tenantId === PLATFORM_TENANT_ID) {
        return NextResponse.json({ error: '仅白标代理可访问' }, { status: 403 });
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = withdrawSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten().fieldErrors }, { status: 400 });
    }
    const { amount_cny, note } = parsed.data;
    const amount = new Prisma.Decimal(amount_cny).toDecimalPlaces(4);
    if (amount.lte(0)) return NextResponse.json({ error: 'invalid_input', message: '金额须大于 0' }, { status: 400 });

    try {
        const result = await prisma.$transaction(async (tx) => {
            const moved = await tx.partnerWallet.updateMany({
                where: { tenant_id: tenantId, balance_cny: { gte: amount } },
                data: { balance_cny: { decrement: amount }, pending_cny: { increment: amount } },
            });
            if (moved.count !== 1) throw new PartnerPricingError('可用余额不足。', 400);
            const withdrawal = await tx.partnerWithdrawal.create({
                data: {
                    tenant_id: tenantId,
                    amount_cny: amount,
                    note: note?.trim() || null,
                    requested_by: admin.user?.id ?? null,
                },
                select: { id: true, amount_cny: true, status: true, created_at: true },
            });
            const wallet = await tx.partnerWallet.findUnique({ where: { tenant_id: tenantId } });
            return { withdrawal, wallet };
        });
        return NextResponse.json(result);
    } catch (error) {
        const { body: errorBody, status } = partnerErrorResponse(error);
        return NextResponse.json(errorBody, { status });
    }
}

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { applyLedgerEntry } from '@/lib/billing/ledger';

export const runtime = 'nodejs';

/**
 * POST /api/admin/enterprise/credit — 独立门户大客户手工入账/调整(P1)。
 *
 * 大客户走对公/大额转账,不接易支付小额网关 —— 打款确认后 admin 在这里入 ¥账本。
 * kind:正数 = recharge(充值),负数 = adjustment(冲正/扣减,必须带 note)。
 * 守门:superadmin(break-glass x-admin-token 也过);目标必须是 portal-mode 客户
 * (newapi 客户的余额在 new-api,走既有 balance-adjust,不在这里混)。
 */
const creditSchema = z
    .object({
        user_id: z.string().uuid().optional(),
        email: z.string().trim().email().optional(),
        amount_cny: z
            .number()
            .refine((n) => Number.isFinite(n) && n !== 0, { message: 'amount_cny 不能为 0' })
            .refine((n) => Math.abs(n) <= 1_000_000, { message: '超出单次上限(±1,000,000)' }),
        note: z.string().trim().min(1, { message: '必须填写备注(打款流水号/原因)' }).max(500),
    })
    .refine((d) => d.user_id || d.email, { message: 'user_id 或 email 必须给一个' });

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = creditSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 });
    }
    const { user_id, email, amount_cny, note } = parsed.data;

    const user = await prisma.user.findFirst({
        where: user_id ? { id: user_id } : { email },
        select: { id: true, email: true, tenant_id: true, billing_mode: true },
    });
    if (!user) return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
    if (user.billing_mode !== 'portal') {
        return NextResponse.json(
            { error: 'not_portal_mode', detail: '该客户余额在 new-api,走 balance-adjust' },
            { status: 400 },
        );
    }

    const r = await applyLedgerEntry(user.id, {
        kind: amount_cny > 0 ? 'recharge' : 'adjustment',
        amount_cny,
        ref: null,
        note,
        createdBy: admin.user?.id ?? null,
        tenantId: user.tenant_id,
    });

    return NextResponse.json({
        user_id: user.id,
        email: user.email,
        amount_cny,
        balance_after: r.balance_after.toFixed(2),
    });
}

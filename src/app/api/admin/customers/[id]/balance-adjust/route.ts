import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { applyLedgerEntry } from '@/lib/billing/ledger';

export const runtime = 'nodejs';

/**
 * POST /api/admin/customers/[id]/balance-adjust — P4c-1 admin 手动调余额。
 *
 * 守门:admin 角色 + tenantScope(IDOR-safe,partner 只能调自己租户客户;镜像 P6b-2 客户管理)。
 * 记账走【唯一】入口 {@link applyLedgerEntry}(kind='adjustment',乐观锁,审计 = LedgerEntry 本身
 * 带 created_by + note)。另写一条 AnalyticsEvent('admin_balance_adjusted')作 admin 行为审计流
 * (best-effort,不阻塞资金操作;LedgerEntry 才是权威审计)。
 *
 * ⚠️ 零客户影响:这是 P4c-1 唯一会写 Account 的路径,且只有 admin 主动调用 —— 自动扣费(P4c-2)
 * 充值改写(P4c-3)都不在本任务。
 */
const adjustSchema = z.object({
    // 带符号:+ 充入 / − 扣减。非 0;|amount| ≤ 100 万(防 fat-finger,安全栏,非 brief 强制)。
    amount_cny: z
        .number()
        .refine((n) => Number.isFinite(n) && n !== 0, { message: 'amount_cny 不能为 0' })
        .refine((n) => Math.abs(n) <= 1_000_000, { message: 'amount_cny 超出单次调整上限(±1,000,000)' }),
    // 必填原因(审计)。
    note: z.string().trim().min(1, { message: '必须填写调整原因' }).max(500),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = adjustSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }

    // IDOR 防护:目标客户必须属于本租户(partner admin 查别租户 user → 拿不到 → 404)。
    const user = await prisma.user.findFirst({
        where: { id, ...tenantScope(admin) },
        select: { id: true, tenant_id: true },
    });
    if (!user) return NextResponse.json({ error: '客户不存在' }, { status: 404 });

    const result = await applyLedgerEntry(user.id, {
        kind: 'adjustment',
        amount_cny: parsed.data.amount_cny,
        note: parsed.data.note,
        createdBy: admin.user?.id ?? null,
        tenantId: user.tenant_id,
    });

    // 补充 admin 行为审计流(LedgerEntry 是权威账本审计;这条 best-effort,失败不回滚资金操作)。
    try {
        await prisma.analyticsEvent.create({
            data: {
                user_id: user.id,
                event_type: 'admin_balance_adjusted',
                properties: {
                    account_id: result.accountId,
                    entry_id: result.entryId,
                    amount_cny: parsed.data.amount_cny,
                    balance_after: result.balance_after.toString(),
                    note: parsed.data.note,
                    adjusted_by: admin.user?.id ?? null,
                    via_break_glass: admin.viaBreakGlass,
                },
            },
        });
    } catch (err) {
        console.warn('[balance-adjust] audit event insert failed:', err instanceof Error ? err.message : err);
    }

    return NextResponse.json(
        {
            ok: true,
            entry_id: result.entryId,
            balance_cny: Number(result.balance_after),
        },
        { status: 201 },
    );
}

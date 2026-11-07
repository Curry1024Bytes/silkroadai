import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { adjustCustomerBalance, BalanceAdjustError } from '@/lib/billing/admin-adjust';

export const runtime = 'nodejs';

/**
 * POST /api/admin/customers/[id]/balance-adjust — admin 手动调余额,按 `billing_mode` 分叉,
 * 让一个按钮对【任何】客户都真生效。
 *
 * - **newapi 客户**(现存全部):余额在 new-api `user.quota` —— 调 `add_quota` 改额度,
 *   **不写 ¥账本**(账本不是 newapi 客户的事实源,写了反混淆)。加=原子 `add`;减=`override`
 *   到 `当前quota − |Δ|`(new-api 的 `add` 不收负值,实测报「cannot be zero」),clamp 0。
 *   改完 **bust quota 缓存**(否则 /dashboard 最长 60s 不更新)+ 写客户可见 `RechargeLog`
 *   (source='adjustment')。
 * - **portal 客户**(P4c,现无客户):走【唯一】账本入口 {@link applyLedgerEntry}(kind='adjustment'),
 *   **= 原逻辑保留** + 补 {@link syncNewapiGate}(调余额可能让余额跨 0 → 重开/关哑门;P4c-1 漏了)。
 *
 * 守门:admin 角色 + tenantScope(IDOR-safe,partner 只能调自己租户客户)。审计必写
 * `AnalyticsEvent('admin_balance_adjusted')`(best-effort,不回滚资金操作)。
 *
 * ⚠️ 不调 `GET /api/user/token`(gotcha #13);newapi 设额度走 `add_quota`(add/override),
 * 不 PUT user 改 quota(会顺带丢 access_token,gotcha #10)。不动充值流(easy-pay/executeRecharge)。
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
        select: { id: true, tenant_id: true, billing_mode: true, newapi_user_id: true },
    });
    if (!user) return NextResponse.json({ error: '客户不存在' }, { status: 404 });

    const amountCny = parsed.data.amount_cny;
    const note = parsed.data.note;
    const adjustedBy = admin.user?.id ?? null;

    // 2026-11-07:核心逻辑抽到 src/lib/billing/admin-adjust.ts(工单补额共用),行为不变。
    try {
        const result = await adjustCustomerBalance(user, {
            amountCny,
            note,
            adjustedBy,
            viaBreakGlass: admin.viaBreakGlass,
        });
        if (result.billing_mode === 'portal') {
            return NextResponse.json(
                { ok: true, billing_mode: 'portal', entry_id: result.entry_id, balance_cny: result.balance_cny },
                { status: 201 },
            );
        }
        return NextResponse.json(
            { ok: true, billing_mode: 'newapi', balance_cny: result.balance_cny },
            { status: 201 },
        );
    } catch (e) {
        if (e instanceof BalanceAdjustError && e.code === 'newapi_not_linked') {
            return NextResponse.json({ error: '该客户未关联 new-api 账号,无法调整额度' }, { status: 409 });
        }
        throw e;
    }
}

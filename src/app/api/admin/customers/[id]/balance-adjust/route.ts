import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { applyLedgerEntry } from '@/lib/billing/ledger';
import { syncNewapiGate } from '@/lib/billing/newapi-gate';
import { getUser, addQuota } from '@/lib/newapi/client';
import { quotaToCny, cnyToQuota } from '@/lib/newapi/quota-units';

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

    // ── portal 客户:¥账本(= 原逻辑保留)+ 补 syncNewapiGate ──
    if (user.billing_mode === 'portal') {
        const result = await applyLedgerEntry(user.id, {
            kind: 'adjustment',
            amount_cny: amountCny,
            note,
            createdBy: adjustedBy,
            tenantId: user.tenant_id,
        });

        // P4c-5 灰度实测发现:调余额可能让余额跨过 0(如给欠费客户补正)→ 哑门要跟着重开/关。
        // P4c-1 的 adjust 漏了这步;这里补上(best-effort,meter §1.5 还会兜底全量 reconcile)。
        try {
            await syncNewapiGate(user.id);
        } catch (err) {
            console.warn('[balance-adjust] syncNewapiGate (portal) failed:', err instanceof Error ? err.message : err);
        }

        try {
            await prisma.analyticsEvent.create({
                data: {
                    user_id: user.id,
                    event_type: 'admin_balance_adjusted',
                    properties: {
                        billing_mode: 'portal',
                        account_id: result.accountId,
                        entry_id: result.entryId,
                        amount_cny: amountCny,
                        balance_after: result.balance_after.toString(),
                        note,
                        adjusted_by: adjustedBy,
                        via_break_glass: admin.viaBreakGlass,
                    },
                },
            });
        } catch (err) {
            console.warn('[balance-adjust] audit event insert failed:', err instanceof Error ? err.message : err);
        }

        return NextResponse.json(
            { ok: true, billing_mode: 'portal', entry_id: result.entryId, balance_cny: Number(result.balance_after) },
            { status: 201 },
        );
    }

    // ── newapi 客户:改 new-api user.quota,不写 ¥账本 ──
    if (user.newapi_user_id == null) {
        return NextResponse.json({ error: '该客户未关联 new-api 账号,无法调整额度' }, { status: 409 });
    }

    const currentQuota = (await getUser(user.newapi_user_id)).quota;
    const deltaQuota = cnyToQuota(Math.abs(amountCny));
    let newQuota: number;
    if (amountCny > 0) {
        // 加:原子增量(new-api `add` 不收负值,实测「Quota change amount cannot be zero」)。
        await addQuota({ userId: user.newapi_user_id, quotaDelta: deltaQuota, mode: 'add' });
        newQuota = currentQuota + deltaQuota;
    } else {
        // 减:用 override 设到 当前 − |Δ|(当前 quota 经 getUser 读)。clamp 0 —— admin 调整
        //     不制造负债(欠费由用量后置产生,不走这个按钮)。
        newQuota = Math.max(0, currentQuota - deltaQuota);
        await addQuota({ userId: user.newapi_user_id, quotaDelta: newQuota, mode: 'override' });
    }

    // 失效 quota 缓存(镜像 executeRecharge 的 bust;否则 /dashboard 最长 60s 看不到新余额)。
    await prisma.user.update({
        where: { id: user.id },
        data: { newapi_quota_cache: null, newapi_used_quota_cache: null, newapi_cached_at: null },
    });

    // 客户可见流水(详情/余额页「余额调整」label)。best-effort,失败不回滚已落地的额度调整。
    try {
        await prisma.rechargeLog.create({
            data: {
                user_id: user.id,
                amount: amountCny, // 带符号 ¥
                balance_before: quotaToCny(currentQuota),
                balance_after: quotaToCny(newQuota),
                newapi_quota_added: BigInt(newQuota - currentQuota), // 带符号 raw quota delta
                newapi_user_id: user.newapi_user_id,
                source: 'adjustment',
                note,
            },
        });
    } catch (err) {
        console.warn('[balance-adjust] recharge_log insert failed:', err instanceof Error ? err.message : err);
    }

    try {
        await prisma.analyticsEvent.create({
            data: {
                user_id: user.id,
                event_type: 'admin_balance_adjusted',
                properties: {
                    billing_mode: 'newapi',
                    amount_cny: amountCny,
                    quota_before: currentQuota,
                    quota_after: newQuota,
                    balance_after: quotaToCny(newQuota).toString(),
                    note,
                    adjusted_by: adjustedBy,
                    via_break_glass: admin.viaBreakGlass,
                },
            },
        });
    } catch (err) {
        console.warn('[balance-adjust] audit event insert failed:', err instanceof Error ? err.message : err);
    }

    return NextResponse.json({ ok: true, billing_mode: 'newapi', balance_cny: quotaToCny(newQuota) }, { status: 201 });
}

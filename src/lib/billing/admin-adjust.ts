/**
 * 管理员调余额(#147 balance-adjust 的核心,2026-11-07 抽出共用,工单补额复用)。
 *
 * 按 billing_mode 分叉:
 *   portal → ¥账本 applyLedgerEntry + syncNewapiGate(best-effort)
 *   newapi → new-api add_quota(+ 用 add 原子增量;− 用 override 设到 当前−|Δ|,clamp 0)
 *            + 清 quota 三缓存列 + RechargeLog(best-effort)
 * 两路都写 analyticsEvent `admin_balance_adjusted`(best-effort)。
 * 行为与原 route 逐行等价;route 只剩鉴权 / zod / HTTP 映射。
 */
import { prisma } from '@/lib/db';
import { applyLedgerEntry } from '@/lib/billing/ledger';
import { syncNewapiGate } from '@/lib/billing/newapi-gate';
import { getUser, addQuota } from '@/lib/newapi/client';
import { quotaToCny, cnyToQuota } from '@/lib/newapi/quota-units';
import type { RechargeSource } from '@prisma/client';

export class BalanceAdjustError extends Error {
    constructor(
        public readonly code: 'newapi_not_linked',
        public readonly status: number,
    ) {
        super(code);
        this.name = 'BalanceAdjustError';
    }
}

export interface AdjustTarget {
    id: string;
    tenant_id: string | null;
    billing_mode: string;
    newapi_user_id: number | null;
}

export interface AdjustOpts {
    /** 带符号 ¥:+ 充入 / − 扣减。 */
    amountCny: number;
    note: string;
    adjustedBy: string | null;
    viaBreakGlass: boolean;
    /** RechargeLog.source(newapi 路);默认 adjustment(客户余额页显示「余额调整」)。 */
    source?: RechargeSource;
    /** 附加写进 analyticsEvent.properties 的上下文(如 ticket_id)。 */
    extra?: Record<string, string | number | boolean | null>;
}

export type AdjustResult =
    | { billing_mode: 'portal'; entry_id: string; balance_cny: number }
    | { billing_mode: 'newapi'; balance_cny: number; quota_before: number; quota_after: number };

export async function adjustCustomerBalance(user: AdjustTarget, opts: AdjustOpts): Promise<AdjustResult> {
    const { amountCny, note, adjustedBy } = opts;

    // ── portal 客户:¥账本 + 补 syncNewapiGate ──
    if (user.billing_mode === 'portal') {
        const result = await applyLedgerEntry(user.id, {
            kind: 'adjustment',
            amount_cny: amountCny,
            note,
            createdBy: adjustedBy,
            tenantId: user.tenant_id,
        });
        // 调余额可能让余额跨过 0 → 哑门要跟着重开/关(best-effort,meter 还会兜底 reconcile)。
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
                        via_break_glass: opts.viaBreakGlass,
                        ...(opts.extra ?? {}),
                    },
                },
            });
        } catch (err) {
            console.warn('[balance-adjust] audit event insert failed:', err instanceof Error ? err.message : err);
        }
        return { billing_mode: 'portal', entry_id: result.entryId, balance_cny: Number(result.balance_after) };
    }

    // ── newapi 客户:改 new-api user.quota,不写 ¥账本 ──
    if (user.newapi_user_id == null) throw new BalanceAdjustError('newapi_not_linked', 409);

    const currentQuota = (await getUser(user.newapi_user_id)).quota;
    const deltaQuota = cnyToQuota(Math.abs(amountCny));
    let newQuota: number;
    if (amountCny > 0) {
        // 加:原子增量(new-api `add` 不收负值,实测「Quota change amount cannot be zero」)。
        await addQuota({ userId: user.newapi_user_id, quotaDelta: deltaQuota, mode: 'add' });
        newQuota = currentQuota + deltaQuota;
    } else {
        // 减:override 设到 当前 − |Δ|,clamp 0 —— admin 调整不制造负债。
        newQuota = Math.max(0, currentQuota - deltaQuota);
        await addQuota({ userId: user.newapi_user_id, quotaDelta: newQuota, mode: 'override' });
    }

    // 失效 quota 缓存(镜像 executeRecharge 的 bust;否则 /dashboard 最长 60s 看不到新余额)。
    await prisma.user.update({
        where: { id: user.id },
        data: { newapi_quota_cache: null, newapi_used_quota_cache: null, newapi_cached_at: null },
    });

    // 客户可见流水。best-effort,失败不回滚已落地的额度调整。
    try {
        await prisma.rechargeLog.create({
            data: {
                user_id: user.id,
                amount: amountCny,
                balance_before: quotaToCny(currentQuota),
                balance_after: quotaToCny(newQuota),
                newapi_quota_added: BigInt(newQuota - currentQuota),
                newapi_user_id: user.newapi_user_id,
                source: opts.source ?? 'adjustment',
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
                    via_break_glass: opts.viaBreakGlass,
                    ...(opts.extra ?? {}),
                },
            },
        });
    } catch (err) {
        console.warn('[balance-adjust] audit event insert failed:', err instanceof Error ? err.message : err);
    }

    return {
        billing_mode: 'newapi',
        balance_cny: quotaToCny(newQuota),
        quota_before: currentQuota,
        quota_after: newQuota,
    };
}

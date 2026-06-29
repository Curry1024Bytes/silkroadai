import 'server-only';
import { prisma } from '@/lib/db';
import { getQuotaWithCache } from '@/lib/newapi/quota-cache';
import { fetchUserRefunds } from '@/lib/newapi/client';
import { quotaToCny } from '@/lib/newapi/quota-units';

export interface CustomerBalance {
    /** 可用余额 ¥。portal = Account.balance_cny;newapi = quotaToCny(remain_quota)。 */
    balanceCny: number;
    /** 累计消费 ¥。portal = Σ|charge| LedgerEntry(翻号后);newapi = quotaToCny(used_quota)。 */
    spentCny: number;
    /** 'portal' = portal ¥账本;'newapi' = new-api quota(默认)。 */
    source: 'portal' | 'newapi';
    /** newapi 路径:new-api 暂不可达、显示的是 stale 缓存(UI 提示"数据稍滞后")。portal 恒 false。 */
    stale: boolean;
    /** newapi 保留原始 remain/used quota(供 USD / raw quota 副显);portal 为 null(无 quota 概念)。 */
    quota: { remain: number; used: number } | null;
}

/**
 * P4c-3.5 统一客户余额/消费读取 —— 所有【客户面】余额展示都走这里,按 `User.billing_mode` 分叉:
 *
 *  - **portal**:`Account.balance_cny` 是唯一余额真相(无 Account → ¥0);累计消费 = 该客户所有
 *    `kind='charge'` LedgerEntry 金额绝对值之和。⚠️ 此刻 new-api `user.quota` 是【哑门开关信号】
 *    (1e9 放行 / 0 拒绝,P4c-3),**不是余额,绝不读它当余额**。
 *  - **newapi**(默认):**完全照旧** —— `getQuotaWithCache`(60s 缓存 + live + stale fallback,
 *    字字不动),`balanceCny = quotaToCny(remain)`、`spentCny = quotaToCny(used)`。
 *
 * ⚠️ portal 的 `spentCny` 只含【翻号后】的 charge(账本从迁移时刻起记)。翻号前的历史消费在
 *    new-api used_quota / UsageRecord 里;`/usage` 页(按 UsageRecord 跨整周期、与 billing_mode
 *    无关)仍展示完整明细,不受影响。
 *
 * 注:newapi 路径比改造前多一次 user 主键读(先取 billing_mode 再 getQuotaWithCache);展示输出
 *    与缓存/fallback 行为字字不变,只多一个 indexed PK lookup。
 */
export async function getCustomerBalance(userId: string): Promise<CustomerBalance> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { billing_mode: true, newapi_user_id: true, account: { select: { id: true, balance_cny: true } } },
    });

    // ── portal:¥账本(Account)是唯一真相,绝不读 new-api quota(它是哑门开关)──
    if (user?.billing_mode === 'portal') {
        const balanceCny = user.account ? Number(user.account.balance_cny) : 0;
        let spentCny = 0;
        if (user.account) {
            const agg = await prisma.ledgerEntry.aggregate({
                where: { account_id: user.account.id, kind: 'charge' },
                _sum: { amount_cny: true },
            });
            // charge 金额带负号(扣减)→ 取绝对值作"累计消费"。
            spentCny = agg._sum.amount_cny ? Math.abs(Number(agg._sum.amount_cny)) : 0;
        }
        return { balanceCny, spentCny, source: 'portal', stale: false, quota: null };
    }

    // ── newapi(默认):getQuotaWithCache(60s 缓存 + fallback)拿 remain/used(毛)──
    const snap = await getQuotaWithCache(userId);
    // new-api 的 used_quota 是【毛消费】,不减视频失败退款(type=6;退款只加回 remain 余额)。
    // 净消费 = 毛 − Σ退款,否则历史消费虚高(2026-06 客户 zyt;seedance 大量失败退款)。
    // 退款查询失败 → 回退毛消费(不阻塞余额/消费展示)。
    let refundQuota = 0;
    if (user?.newapi_user_id != null) {
        try {
            const refunds = await fetchUserRefunds({
                user_id: user.newapi_user_id,
                username: `c-${userId.slice(0, 8)}`, // 与 provisionNewCustomer 约定一致
            });
            refundQuota = refunds.reduce((sum, r) => sum + r.quota, 0);
        } catch (err) {
            console.warn(`[customer-balance] 退款查询失败 user ${userId},历史消费暂用毛消费:`, err);
        }
    }
    const netUsed = Math.max(0, snap.used_quota - refundQuota);
    return {
        balanceCny: quotaToCny(snap.remain_quota),
        spentCny: quotaToCny(netUsed),
        source: 'newapi',
        stale: snap.source === 'fallback',
        quota: { remain: snap.remain_quota, used: netUsed },
    };
}

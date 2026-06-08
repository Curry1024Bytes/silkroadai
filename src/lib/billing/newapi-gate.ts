import 'server-only';
import { prisma } from '@/lib/db';
import { addQuota } from '@/lib/newapi/client';
import { billingSourceIsPortal } from './billing-source';

/**
 * 哑门「放行」额度。portal 客户余额 > 0 时把 new-api `user.quota` 顶到这个大值。
 *
 * 它只是【开关信号】,不是余额、不计扣费 —— 每轮被 portal 覆盖重设。取够大:一个轮询
 * 周期内 new-api 自己按 ModelRatio 扣这个 quota 也绝扣不光($2000 量级),所以 new-api
 * 永远扣不到 0、不会自作主张关门;**唯一**把它打到 0 的是 portal 发现 balance ≤ 0。
 * (new-api quota 是 int64 —— 余额 > $4k 就超 int32,故大值安全;1e9 已在 throwaway probe 验证。)
 */
export const GATE_OPEN_QUOTA = 1_000_000_000;

/**
 * P4c-3 哑门执行器 —— 把【portal 模式】客户的 new-api `user.quota` 当"放行/拒绝"开关,
 * portal 只控制它开/关(post-hoc 余额门,不在 proxy 建实时门)。
 *
 * ⚠️⚠️ 铁律:只碰 `BILLING_SOURCE='portal'` 且 `user.billing_mode='portal'` 的客户。
 *   **第一行就 scope 校验,不满足直接 return** —— newapi 客户传进来 quota 一个字不动
 *   (他们的 quota 就是真余额,继续走 add_quota 充值管理,如常)。
 * ⚠️⚠️ 绝不双扣:portal 客户的 new-api quota **只是开关信号**(每轮被覆盖重设),
 *   **不是**他们的余额、**不计入扣费**。portal `Account.balance_cny` 是唯一扣费/余额事实源。
 *
 * 机制(实测 `add_quota mode='override'` = 绝对设值,见 throwaway probe 2026-06-09):
 *   - balance > 0 → quota = {@link GATE_OPEN_QUOTA}(放行;每轮幂等顶满)。
 *   - balance ≤ 0 / 无 Account → quota = 0(new-api 拒 → 客户得 `insufficient_user_quota`,
 *     正好是"余额不足"的对味报错)。
 *
 * 用 `/api/user/manage` add_quota override(不 PUT user)→ **不动 access_token**(gotcha #10);
 * **绝不调** `GET /api/user/token`(gotcha #13)。
 *
 * 触发点:meter 扣完账后(余额掉≤0 → 关门)、充值成功后(余额转正 → 开门)。失败由调用方
 * 兜底(非致命:下一轮 meter 会再 sync)。
 */
export async function syncNewapiGate(userId: string): Promise<void> {
    // 全局门:BILLING_SOURCE 非 portal(默认/未设)→ 整个 P4c 计费关 → 不碰任何人的 new-api。
    if (!billingSourceIsPortal()) return;

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            billing_mode: true,
            newapi_user_id: true,
            account: { select: { balance_cny: true } },
        },
    });
    // 单客户门:非 portal 模式 → 绝不碰其 quota(铁律)。无 newapi_user_id 也跳过(没法路由)。
    if (!user || user.billing_mode !== 'portal' || user.newapi_user_id == null) return;

    const balanceCny = user.account?.balance_cny;
    const target = balanceCny && balanceCny.greaterThan(0) ? GATE_OPEN_QUOTA : 0;

    // 绝对设值(override):每轮把 quota 顶满 GATE_OPEN_QUOTA,或在余额耗尽时打到 0。
    await addQuota({ userId: user.newapi_user_id, quotaDelta: target, mode: 'override' });
}

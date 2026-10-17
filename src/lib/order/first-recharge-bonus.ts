/**
 * 首充 bonus 总开关。
 *
 * 2026-10-17 operator 决定下架首充 20%(邀请码 30%)bonus。关掉后:
 *   - executeRecharge 不再 peek/CAS-claim `User.first_recharge_bonus_granted`,
 *     applyTopup 永远 `extraBonusQuota: 0`,RechargeLog.bonus_quota_added = 0
 *   - `/pay` 不再渲染首充横幅;落地页 / 注册页文案已改
 *   - schema 字段、race-safe claim 机制、测试全部保留(测试里 mock 本函数返 true)
 *
 * 要重新上架:把返回值改 true + 恢复 `/pay` 横幅(git 历史
 * `src/app/pay/first-recharge-bonus-banner.tsx`)。无需 migration。
 * 已 flip 过 granted=true 的存量用户不受开关影响(关着时也不会再 flip)。
 */
export function isFirstRechargeBonusEnabled(): boolean {
    return false;
}

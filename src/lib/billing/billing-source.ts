import 'server-only';

/**
 * P4c 全局计费总闸(emergency kill-switch)。env `BILLING_SOURCE`:
 *   - 精确 = 'portal' → portal ¥账本计费【开】(还要配合单客户 `User.billing_mode='portal'` 才真扣)。
 *   - 其它 / 未设     → 'newapi'(默认):任何人都不走 portal 计费(= 现状,零扣费)。
 *
 * 故意【直接读 process.env、不经 getEnv() 的 zod 校验】:
 *   1. fail-closed —— 只有精确 'portal' 才开;拼错 / 空 / 未设一律 newapi(安全方向)。
 *   2. kill-switch 不能因为值拼错就让整个 app 启动崩(getEnv 的 zod 校验失败会 throw)。
 *   3. 不缓存 → 改 env + 重启即时生效,也便于单测 `vi.stubEnv('BILLING_SOURCE', …)`。
 * (与 NEWAPI_* 等运维 env 一样走直读,不进 config schema。)
 *
 * P4c-2 计量扣费 + P4c-3 余额门 / 充值改写都用这同一道全局门。
 *
 * ⚠️⚠️ 运维铁律 —— 这个 env 必须与 `User.billing_mode='portal'` 保持一致:
 *   - 翻到 portal【前】先开闸:`migrateUserToPortal` 第一行硬挡闸关时翻号(否则半翻号、客户钱锁死,
 *     357 事故根因,见 billing-migration.ts 的 `BillingSourceNotPortalError`)。
 *   - 关闸【前】先把【所有】portal 客户回滚到 newapi:单关这个 env【不是】完整 revert —— 会留下脱钩的
 *     portal 客户(哑门停在 1e9、meter 不扣 → 无限免费用)。shadow-meter.ts 每轮
 *     `countOrphanedPortalCustomers` 兜底告警这种反向危险态。
 */
export function billingSourceIsPortal(): boolean {
    return process.env.BILLING_SOURCE === 'portal';
}

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
 */
export function billingSourceIsPortal(): boolean {
    return process.env.BILLING_SOURCE === 'portal';
}

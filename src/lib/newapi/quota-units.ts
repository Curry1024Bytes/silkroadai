/**
 * Pure quota-unit conversions, safe for client bundles.
 *
 * Extracted from `src/lib/newapi/client.ts` (which has `import 'server-only'`
 * + module-top-level admin-token env check) so client components like
 * <KeysList /> can render `quotaToCny(...)` without dragging the entire
 * server-side new-api client into the browser bundle.
 *
 * No side effects, no env reads at module load — just three constants and
 * four pure functions. Both server and client code import from here freely.
 *
 * Why not put these on `client.ts` and let tree-shaking handle it?
 * - Tree-shaking is unreliable across bundler boundaries (webpack / turbopack
 *   versions, dev vs prod modes, dynamic imports). The W6 D4 regression
 *   shipped in prod proved this: keys-list imported `quotaToCny` from a
 *   server-side module and ate the entire `client.ts` evaluation, including
 *   its top-level `throw new Error('Missing required env: NEWAPI_ADMIN_TOKEN')`.
 * - Putting pure helpers in their own no-side-effects module is the
 *   convention for client-safe utilities; `import 'server-only'` enforces
 *   the boundary at build time.
 *
 * Env knobs (read at module load, but only constants — no I/O):
 *   - NEWAPI_QUOTA_PER_USD: raw quota in one new-api technical billing unit
 *   - USD_TO_CNY_RATE:      legacy-named conversion from that unit to CNY
 *   - REAL_USD_TO_CNY_RATE: real market FX used only for USD display
 */

export const QUOTA_PER_USD = parseInt(process.env.NEWAPI_QUOTA_PER_USD || '500000', 10);
export const USD_TO_CNY_RATE = parseFloat(process.env.USD_TO_CNY_RATE || '7.2');

/** quota → legacy-named new-api technical billing units */
export function quotaToUsd(quota: number): number {
    return quota / QUOTA_PER_USD;
}

/** quota → CNY (展示给中国客户) */
export function quotaToCny(quota: number): number {
    return quotaToUsd(quota) * USD_TO_CNY_RATE;
}

/** legacy-named new-api technical billing units → quota */
export function usdToQuota(usd: number): number {
    return Math.round(usd * QUOTA_PER_USD);
}

/** CNY → quota (用户充 100 元 → portal 算出对应 quota 调 add_quota) */
export function cnyToQuota(cny: number): number {
    return usdToQuota(cny / USD_TO_CNY_RATE);
}

/**
 * 真实市场汇率 $→¥,与上面的 quota 换算因子是两回事。
 *
 * 计价单位迁移(QuotaPerUnit=500k、USD_TO_CNY_RATE=1,quota 单位=¥)之后,
 * `USD_TO_CNY_RATE` 只是 quota↔¥ 换算链的一环,不再是真汇率;凡是要给客户/
 * 运营展示【真实美元】的地方(OpenAI 兼容 billing 端点、remain_usd 等)一律
 * 用本常量。未设 `REAL_USD_TO_CNY_RATE` 时回落 `USD_TO_CNY_RATE`,所以迁移前
 * 两者同值、行为零变化。
 */
export const REAL_USD_TO_CNY = parseFloat(process.env.REAL_USD_TO_CNY_RATE || String(USD_TO_CNY_RATE));

/** quota → 真实 USD(先折 ¥ 再按真汇率折 $,展示用;迁移前等价于 quotaToUsd) */
export function quotaToRealUsd(quota: number): number {
    return quotaToCny(quota) / REAL_USD_TO_CNY;
}

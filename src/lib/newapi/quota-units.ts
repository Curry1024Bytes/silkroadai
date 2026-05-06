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
 *   - NEWAPI_QUOTA_PER_USD: how many raw quota = 1 USD (new-api default 500_000)
 *   - USD_TO_CNY_RATE:      FX rate from new-api admin / market rate
 */

export const QUOTA_PER_USD = parseInt(process.env.NEWAPI_QUOTA_PER_USD || '500000', 10);
export const USD_TO_CNY_RATE = parseFloat(process.env.USD_TO_CNY_RATE || '7.2');

/** quota → USD */
export function quotaToUsd(quota: number): number {
    return quota / QUOTA_PER_USD;
}

/** quota → CNY (展示给中国客户) */
export function quotaToCny(quota: number): number {
    return quotaToUsd(quota) * USD_TO_CNY_RATE;
}

/** USD → quota */
export function usdToQuota(usd: number): number {
    return Math.round(usd * QUOTA_PER_USD);
}

/** CNY → quota (用户充 100 元 → portal 算出对应 quota 调 add_quota) */
export function cnyToQuota(cny: number): number {
    return usdToQuota(cny / USD_TO_CNY_RATE);
}

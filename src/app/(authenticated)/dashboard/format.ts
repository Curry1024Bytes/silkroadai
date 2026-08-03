/**
 * Pure formatting helpers for the per-call detail table (客户控制台三合一).
 *
 * Kept side-effect free + client-safe so both the server page and the
 * `CallDetailTable` client island import them, and the unit tests exercise
 * the logic directly (no rendering needed).
 *
 * Source fields come from new-api `NewApiUsageLog` (see §0 of the brief):
 *   - `use_time`  (new-api 单位是【秒】;page 层 `toCallRow` ×1000 转成 ms 再喂
 *      formatDuration —— 否则 56 秒的生图会显示成 "56ms")  → 时长
 *   - `prompt_tokens` / `completion_tokens` → Tokens(输入/输出)
 *   - `type` (2=consume 成功, 5=error 失败) → 结果
 */

/** Result of a single call. Maps new-api `log.type` to a customer-facing
 *  success/failure verdict. Anything other than the two known consume/error
 *  types is treated as success (we only ever fetch type 2 + 5 for the table,
 *  so this is just a defensive default). */
export type CallResult = 'success' | 'error';

export function callResult(type: number): CallResult {
    // 5 = new-api 同步错误;6 = 视频异步任务失败(已退款,dashboard 关联后标成此类型)。
    return type === 5 || type === 6 ? 'error' : 'success';
}

/**
 * Friendly call duration from milliseconds.
 *   - 0 (or missing) → "—" (error rows / image gen often report 0)
 *   - < 1000ms       → "820ms"
 *   - ≥ 1000ms       → "1.2s" (one decimal), "12s" / "1m 5s" for longer
 */
export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const totalSec = ms / 1000;
    if (totalSec < 60) {
        // One decimal under a minute (1.2s); drop a trailing ".0".
        const s = totalSec.toFixed(1);
        return `${s.endsWith('.0') ? s.slice(0, -2) : s}s`;
    }
    const mins = Math.floor(totalSec / 60);
    const secs = Math.round(totalSec % 60);
    return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;
}

/**
 * Friendly token cell.
 *   - `perImageBilled`(按张计费的生图,如 Gemini 生图)→ 一律 "—":token 数是噪声、极不一致
 *     (客户误以为"显示异常")。**注意**:gpt-image-2 等【按 token 计费】的生图 perImageBilled=false,
 *     token 就是计费依据,要如实显示 —— 判据由调用方(toCallRow/toLogRow)按 `other.model_price` 算好传入。
 *   - 其余(含所有 LLM 与按 token 的生图):两端都 0 → "—"(不显示误导的 "0 / 0");否则 "输入 / 输出"。
 */
export function formatTokens(promptTokens: number, completionTokens: number, perImageBilled = false): string {
    if (perImageBilled) return '—';
    const p = Number.isFinite(promptTokens) ? promptTokens : 0;
    const c = Number.isFinite(completionTokens) ? completionTokens : 0;
    if (p === 0 && c === 0) return '—';
    return `${p.toLocaleString('en-US')} / ${c.toLocaleString('en-US')}`;
}

/**
 * 缓存读写副行(参照 new-api 日志的缓存展示)。主行 输入/输出 之下的灰色小字:
 *   - 读写都 0(绝大多数调用)或按张计费 → ''(不渲染副行,表格不加噪)
 *   - 只有读 → "缓存读 127,885";只有写 → "缓存写 1,304";都有 → "缓存读 X · 缓存写 Y"
 * 背景:Anthropic 面 prompt_tokens 不含缓存部分 —— prompt-cache 重度用户(如 CCMAX)
 * 会看到"输入 2 却 ¥0.07",缓存行就是解释。
 */
export function formatCacheTokens(cacheReadTokens: number, cacheWriteTokens: number, perImageBilled = false): string {
    if (perImageBilled) return '';
    const r = Number.isFinite(cacheReadTokens) && cacheReadTokens > 0 ? cacheReadTokens : 0;
    const w = Number.isFinite(cacheWriteTokens) && cacheWriteTokens > 0 ? cacheWriteTokens : 0;
    const parts: string[] = [];
    if (r > 0) parts.push(`缓存读 ${r.toLocaleString('en-US')}`);
    if (w > 0) parts.push(`缓存写 ${w.toLocaleString('en-US')}`);
    return parts.join(' · ');
}

// 日志展示 helpers 都在共享 lib(dashboard 页 + /logs 页 + /api/portal/logs 复用),此处 re-export
// 保持既有 import 不变(折叠重试失败 / 错误脱敏 / 计费口径判断)。
export { collapseRetriedFailures, sanitizeLogContent, isImageModel } from '@/lib/newapi/log-display';

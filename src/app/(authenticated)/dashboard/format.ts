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

/** 按模型名判断是否生图模型。生图按【张】计费(¥/张),token 数对它无意义 —— 上游
 *  回报极不一致(gpt-image-2 实测同样 ¥0.05/张,token 见过 1/0、9/124、1212/1105…)。
 *  client-safe 纯字符串匹配(不引 server-only 的 import-catalog)。 */
export function isImageModel(model: string): boolean {
    const m = model.toLowerCase();
    return m.includes('image') || m.includes('dall-e') || m.includes('imagen');
}

/**
 * Friendly token cell.
 *   - 生图模型 → 一律 "—":按张计费,token 数无意义且极不一致(客户误以为"显示异常")。
 *   - 其余模型:两端都 0(`prompt_tokens===0 && completion_tokens===0`)→ "—"
 *     (不显示误导的 "0 / 0");否则 "输入 / 输出"。
 */
export function formatTokens(promptTokens: number, completionTokens: number, model = ''): string {
    if (isImageModel(model)) return '—';
    const p = Number.isFinite(promptTokens) ? promptTokens : 0;
    const c = Number.isFinite(completionTokens) ? completionTokens : 0;
    if (p === 0 && c === 0) return '—';
    return `${p.toLocaleString('en-US')} / ${c.toLocaleString('en-US')}`;
}

// 折叠重试中间失败 + 错误文案脱敏移到共享 lib(dashboard 页 + /logs 页 + /api/portal/logs 复用),
// 此处 re-export 保持既有 import 不变。
export { collapseRetriedFailures, sanitizeLogContent } from '@/lib/newapi/log-display';

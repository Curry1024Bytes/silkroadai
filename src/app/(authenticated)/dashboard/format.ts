/**
 * Pure formatting helpers for the per-call detail table (客户控制台三合一).
 *
 * Kept side-effect free + client-safe so both the server page and the
 * `CallDetailTable` client island import them, and the unit tests exercise
 * the logic directly (no rendering needed).
 *
 * Source fields come from new-api `NewApiUsageLog` (see §0 of the brief):
 *   - `use_time`  (ms)  → 时长
 *   - `prompt_tokens` / `completion_tokens` → Tokens(输入/输出)
 *   - `type` (2=consume 成功, 5=error 失败) → 结果
 */

/** Result of a single call. Maps new-api `log.type` to a customer-facing
 *  success/failure verdict. Anything other than the two known consume/error
 *  types is treated as success (we only ever fetch type 2 + 5 for the table,
 *  so this is just a defensive default). */
export type CallResult = 'success' | 'error';

export function callResult(type: number): CallResult {
    return type === 5 ? 'error' : 'success';
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
 * Friendly token cell. Image generation (and other non-LLM calls) report
 * `prompt_tokens === 0 && completion_tokens === 0` — show "—" rather than a
 * misleading "0 / 0" (生图友好, brief §3). Otherwise "输入 / 输出".
 */
export function formatTokens(promptTokens: number, completionTokens: number): string {
    const p = Number.isFinite(promptTokens) ? promptTokens : 0;
    const c = Number.isFinite(completionTokens) ? completionTokens : 0;
    if (p === 0 && c === 0) return '—';
    return `${p.toLocaleString('en-US')} / ${c.toLocaleString('en-US')}`;
}

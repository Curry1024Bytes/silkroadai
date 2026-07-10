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

/**
 * 折叠"失败了但重试 / failover 成功"的中间失败行 —— 别让客户日志被这些中间过程刷屏。
 *
 * 两种重试来源:
 *   1. new-api 内部 failover:把同一请求的多次尝试用【同一 request_id】记多行(失败渠道 + 成功渠道)。
 *      → 失败行的 request_id 出现在成功集合里 = 该请求最终成功了 → 藏掉失败行。
 *   2. proxy 尺寸重试(#224,size-must-use):是【新 request_id】,按 request_id 盖不住 →
 *      失败行是 "size must use" 且同期(180s 内)有一条成功 → 藏掉(几乎必然是被重试成功了)。
 *
 * 真失败(内容审查拒绝等,独立 request_id、无对应成功)照常返回。仅影响【展示】,不改计费 / 结果判定。
 */
export function collapseRetriedFailures<
    S extends { request_id: string; created_at: number },
    E extends { request_id: string; created_at: number; content: string },
>(consume: readonly S[], errors: readonly E[]): E[] {
    const succeededRids = new Set(consume.map((l) => l.request_id).filter(Boolean));
    const successTimes = consume.map((l) => l.created_at).sort((a, b) => a - b);
    const hasSuccessWithin = (t: number, sec: number) => successTimes.some((st) => st >= t && st <= t + sec);
    return errors.filter((e) => {
        if (e.request_id && succeededRids.has(e.request_id)) return false; // failover 中间失败
        if (/size must use/i.test(e.content) && hasSuccessWithin(e.created_at, 180)) return false; // proxy 尺寸重试
        return true;
    });
}

/** 客户日志错误文案脱敏 + 友好化:隐藏上游来源(adobe / we-token / zhiyunai 等),把常见错误映射成
 *  客户能看懂、能行动的中文。仅作用于【展示】,不改计费 / 真实结果判定。服务端 `toCallRow` 里调用,
 *  原始 content 不进浏览器。 */
export function sanitizeLogContent(content: string): string {
    if (!content) return content;
    const c = content.toLowerCase();
    if (/image_unsafe|content rejected|appear to be unsafe|safety system|content_policy|\badobe\b/.test(c)) {
        return '图片内容被安全系统判定为不适宜,请调整提示词后重试';
    }
    if (/size must use|invalid size|must be multiples of 16|edges must be multiples/.test(c)) {
        return '图片尺寸参数不合规(请使用「宽x高」像素格式,如 1024x1024)';
    }
    if (/负载已饱和|overloaded|do request failed|temporarily unavailable|no available channel|\b429\b/.test(c)) {
        return '服务繁忙,请稍后重试';
    }
    return content.replace(/\b(adobe|we-token|zhiyunai|nexaxis|amutes|vakv|midou|czeq)\b/gi, '上游');
}

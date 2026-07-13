/**
 * 客户日志【展示层】纯helpers —— 折叠重试中间失败 + 错误文案脱敏。
 *
 * 客户看到的调用日志会被两类"中间失败"噪音污染:
 *   1. new-api 内部 failover:同一请求多次尝试用【同一 request_id】记多行(失败渠道 + 成功渠道);
 *   2. proxy 尺寸重试(#224):是【新 request_id】。
 * 折叠后只保留最终结果;并把错误文案脱敏(隐藏 adobe / we-token 等上游来源)成友好中文。
 * 纯函数、client-safe、无副作用 —— dashboard 页 + /logs 页 + /api/portal/logs 都复用。
 */

/**
 * 折叠"失败了但重试 / failover 成功"的中间失败行。规则:
 *   1. 失败行的 request_id 出现在成功集合里 = 该请求最终成功 → 藏掉失败行(new-api failover);
 *   2. 失败行是 "size must use"(proxy 尺寸重试)且同期(180s 内)有成功 → 藏掉。
 * 真失败(内容拒绝等,独立 request_id、无对应成功)照常返回。仅影响展示,不改计费 / 结果判定。
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
 *  客户能看懂、能行动的中文。仅作用于【展示】,不改计费 / 真实结果判定。服务端调用,原文不进浏览器。 */
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

/** 名字看着像不像生图模型(粗粒度启发式)。仅当日志行缺 `other`/model_price 时,`isPerImageBilled`
 *  拿它兜底。client-safe 纯字符串匹配(不引 server-only 的 import-catalog)。 */
export function isImageModel(model: string): boolean {
    const m = (model || '').toLowerCase();
    return m.includes('image') || m.includes('dall-e') || m.includes('imagen');
}

/** 从日志行 `other`(new-api 回的 JSON 串)取 `model_price`;取不到 → null。
 *  `model_price >= 0` = 按张(ModelPrice 定价);`-1` = 未设 ModelPrice,走 ModelRatio 按 token 计费。 */
export function parseModelPrice(other: string | null | undefined): number | null {
    if (!other) return null;
    try {
        const o = JSON.parse(other) as { model_price?: unknown };
        return typeof o.model_price === 'number' ? o.model_price : null;
    } catch {
        return null;
    }
}

/** 这次调用是否「按张计费」(生图 ModelPrice 定价)。
 *   - `true`  → token 数是噪声(上游回报极不一致)→ 展示层显示 "—"(如 Gemini 生图)。
 *   - `false` → 按 token 计费(ModelRatio,含 gpt-image-2 / az-gpt-image-2 / 所有 LLM)→ token 就是
 *     计费依据,要如实显示。
 *  判据优先用【每条请求真实计费口径】`other.model_price`(≥0 按张、-1/缺省按 token);`other` 解析不出
 *  才回退模型名 —— 名字像生图【且不是 gpt-image 族】才算按张(gpt-image 族确定按 token,不能凭名字藏)。 */
export function isPerImageBilled(other: string | null | undefined, model: string): boolean {
    const mp = parseModelPrice(other);
    if (mp != null) return mp >= 0;
    const m = (model || '').toLowerCase();
    if (m.includes('gpt-image')) return false; // gpt-image 族按 token 计费,即使缺 other 也要显示 token
    return isImageModel(m);
}

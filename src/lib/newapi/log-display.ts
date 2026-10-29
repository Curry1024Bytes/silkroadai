/**
 * 客户日志【展示层】纯helpers —— 折叠重试中间失败 + 错误文案脱敏。
 *
 * 客户看到的调用日志会被三类"中间失败"噪音污染:
 *   1. new-api 内部 failover:同一请求多次尝试用【同一 request_id】记多行(失败渠道 + 成功渠道);
 *   2. proxy 尺寸重试(#224):是【新 request_id】;
 *   3. image-adapter 守门拒(#317 起):按张计费渠道只接盈利档,其余一律 503 让 new-api 换渠道。
 * 折叠后只保留最终结果;并把错误文案脱敏(隐藏 adobe / we-token 等上游来源)成友好中文。
 * 纯函数、client-safe、无副作用 —— dashboard 页 + /logs 页 + /api/portal/logs 都复用。
 */

/**
 * 该失败行是不是 image-adapter 的内部 failover 信号(客户不该看见)。
 *
 * 适配器(ch154 ominiapi 按张计费)priority 最高 → **全站 97% 的 gpt-image 请求先打它**,
 * 非盈利档(1k / 2k-低质)当场 503 让 new-api 换 azure 渠道 —— 客户照常拿到图,但 new-api
 * 会为这次尝试记一条 type=5。08-04 单日 **42.6 万条**,把客户日志页刷屏。
 *
 * 只认适配器独有的 `other.error_code === 'upstream_unavailable'`,不会误伤别的 5xx。
 * 规则 1(request_id 配对)理论上能吃掉它们,但**依赖失败行与成功行落在同一取数窗口**:
 * dashboard 分开取 type=2 / type=5(150 / 50 条),这类噪音把 50 条错误位全占满、对应成功
 * 却在窗口外 → 折叠不掉。所以这里改成不依赖分页的无条件规则。
 *
 * 安全性:实测抽样 500 条中 94% 有同 request_id 的成功行(本就该藏);剩余 6%(全渠道都失败)
 * **100% 在别的渠道另有同 request_id 的错误行** —— 那条带真实原因(内容安全 / 坏图)且已被
 * sanitizeLogContent 友好化,所以藏掉本行不会让客户失去唯一解释。
 */
function isAdapterFailoverNoise(other: string | null | undefined): boolean {
    if (!other || !other.includes('upstream_unavailable')) return false; // 快路径:绝大多数行直接跳过 JSON.parse
    try {
        return (JSON.parse(other) as { error_code?: unknown }).error_code === 'upstream_unavailable';
    } catch {
        return false;
    }
}

/**
 * 折叠"失败了但重试 / failover 成功"的中间失败行。规则:
 *   1. 失败行的 request_id 出现在成功集合里 = 该请求最终成功 → 藏掉失败行(new-api failover);
 *   2. 失败行是 "size must use"(proxy 尺寸重试)且同期(180s 内)有成功 → 藏掉;
 *   3. 失败行是 image-adapter 守门拒(见 isAdapterFailoverNoise)→ 无条件藏掉。
 * 真失败(内容拒绝等,独立 request_id、无对应成功)照常返回。仅影响展示,不改计费 / 结果判定。
 */
export function collapseRetriedFailures<
    S extends { request_id: string; created_at: number },
    E extends { request_id: string; created_at: number; content: string; other?: string | null },
>(consume: readonly S[], errors: readonly E[]): E[] {
    const succeededRids = new Set(consume.map((l) => l.request_id).filter(Boolean));
    const successTimes = consume.map((l) => l.created_at).sort((a, b) => a - b);
    const hasSuccessWithin = (t: number, sec: number) => successTimes.some((st) => st >= t && st <= t + sec);
    return errors.filter((e) => {
        if (e.request_id && succeededRids.has(e.request_id)) return false; // failover 中间失败
        if (/size must use/i.test(e.content) && hasSuccessWithin(e.created_at, 180)) return false; // proxy 尺寸重试
        if (isAdapterFailoverNoise(e.other)) return false; // image-adapter 守门拒
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

/** 从日志行 `other` 取缓存 token 数:`cache_tokens` = 缓存读(命中),`cache_creation_tokens` =
 *  缓存写(创建)。取不到 / 解析失败 → 0/0。注意语义随上游而异:Anthropic 面(usage_semantic=
 *  anthropic)`prompt_tokens` 不含缓存部分(读写单列),OpenAI 面 cached 含在 prompt 里 ——
 *  展示层只如实分列显示,不做加总推断。 */
export function parseCacheTokens(other: string | null | undefined): { read: number; write: number } {
    if (!other) return { read: 0, write: 0 };
    try {
        const o = JSON.parse(other) as { cache_tokens?: unknown; cache_creation_tokens?: unknown };
        return {
            read: typeof o.cache_tokens === 'number' && o.cache_tokens > 0 ? o.cache_tokens : 0,
            write:
                typeof o.cache_creation_tokens === 'number' && o.cache_creation_tokens > 0
                    ? o.cache_creation_tokens
                    : 0,
        };
    } catch {
        return { read: 0, write: 0 };
    }
}

/**
 * type=6 同时承载两种退款：任务失败全额退款，以及出片后的实际用量结算退款。
 * 结算退款的 other 会带预扣/实际 quota；旧版本或某些 adaptor 只把结算原因写进 content。
 * 解析失败时必须按普通失败退款处理，不能把一条未知退款展示成客户可见的消费抵扣。
 */
export interface SettlementRefundLog {
    type: number;
    other?: string | null;
    content?: string | null;
}

export interface SettlementRefundDetails {
    preConsumedQuota: number | null;
    actualQuota: number | null;
}

const SETTLEMENT_REFUND_REASONS = ['任务用量表达式结算', 'adaptor计费调整', 'token重算：tokens='];

function finiteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

/** 返回结算退款的可公开计费细节；普通失败退款和坏数据返回 null。 */
export function parseSettlementRefundDetails(log: SettlementRefundLog): SettlementRefundDetails | null {
    if (log.type !== 6) return null;

    if (log.other) {
        try {
            const parsed = JSON.parse(log.other) as Record<string, unknown>;
            const preConsumedQuota = finiteNumber(parsed.pre_consumed_quota);
            const actualQuota = finiteNumber(parsed.actual_quota);
            if (preConsumedQuota !== null && actualQuota !== null) {
                return { preConsumedQuota, actualQuota };
            }
        } catch {
            // 旧日志的 other 可能损坏；继续用 content 的兼容判据。
        }
    }

    const content = log.content || '';
    if (SETTLEMENT_REFUND_REASONS.some((reason) => content.includes(reason))) {
        return { preConsumedQuota: null, actualQuota: null };
    }
    return null;
}

export function isSettlementRefund(log: SettlementRefundLog): boolean {
    return parseSettlementRefundDetails(log) !== null;
}

/** type=6 退款的两种来源:出片后按实际用量结算退还差额,或任务失败全额退还预扣。 */
export type RefundKind = 'settlement' | 'failure';

export function refundKindOf(log: SettlementRefundLog): RefundKind | null {
    if (log.type !== 6) return null;
    return isSettlementRefund(log) ? 'settlement' : 'failure';
}

/** 失败退款配上预扣行时,预扣行的说明(预扣行标「失败」、金额 ¥0)。 */
export const FAILED_VIDEO_REFUND_NOTE = '视频任务未生成成功,已自动退还本次预扣费用(未实际扣费)。';

/** 失败退款找不到预扣行时(在别的页、日期范围外或导出批次外),单独退款行的说明。 */
export function unmatchedFailureRefundContent(refund: string): string {
    return `视频任务未生成成功，已自动退还预扣的 ${refund}。对应的预扣记录不在当前列表中（可能在其他页或所选日期范围之外）。`;
}

/** 结算退款行的客户可见说明。formatQuota 由 server 侧传入，避免在共享展示 helper 中读取环境变量。 */
export function settlementRefundContent(
    log: SettlementRefundLog & { quota: number },
    formatQuota: (quota: number) => string,
): string {
    const refund = formatQuota(Math.abs(log.quota));
    const details = parseSettlementRefundDetails(log);
    if (details && details.preConsumedQuota !== null && details.actualQuota !== null) {
        return `按实际用量结算，退还多扣的 ${refund}（预扣 ${formatQuota(details.preConsumedQuota)}，实际 ${formatQuota(details.actualQuota)}）`;
    }
    return `按实际用量结算，退还多扣的 ${refund}`;
}

/** 这次调用是否「按张计费」(生图 ModelPrice 定价)。
 *   - `true`  → token 数是噪声(上游回报极不一致)→ 展示层显示 "—"(如 Gemini 生图)。
 *   - `false` → 按 token 计费(ModelRatio,含 gpt-image-2 / az-gpt-image-2 / 所有 LLM)→ token 就是
 *     计费依据,要如实显示。
 *  判据优先用【每条请求真实计费口径】`other.model_price`(≥0 按张、-1/缺省按 token);`other` 解析不出
 *  才回退模型名 —— gpt-image-2-{1,2,4}k 是明确的 ModelPrice 固定价 SKU;
 *  canonical gpt-image-2 / az-gpt-image 族仍按 token 展示。 */
export function isPerImageBilled(other: string | null | undefined, model: string): boolean {
    const mp = parseModelPrice(other);
    if (mp != null) return mp >= 0;
    const m = (model || '').toLowerCase();
    if (/^gpt-image-2-[124]k$/.test(m)) return true;
    if (m.includes('gpt-image')) return false; // gpt-image 族按 token 计费,即使缺 other 也要显示 token
    return isImageModel(m);
}

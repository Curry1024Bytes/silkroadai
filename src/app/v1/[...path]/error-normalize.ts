/**
 * image2(gpt-image-2)客户可见错误统一分类器 — 第 2 步(终态):错误体 + HTTP 状态码
 * 全部对齐 OpenAI 官方契约。方案见 image2-error-code-unification-brief.md;
 * 第 1 步(只统一体,status 透传)= PR #389,本步(#390+)把 status 也切到官方语义:
 * 限流/余额 → 429、容量 → 503、临时错 → 500、审核 → 400 `moderation_blocked`。
 *
 * 对客契约对齐 OpenAI 官方错误形 `{"error":{message,type,param,code}}`:客户 SDK 按
 * status + error.code/error.type 分类异常(429→RateLimitError、5xx→APIError/重试),
 * message 只给人读。这里把链路上五花八门的上游原文(we-token 嵌套 JSON、azure region 文案、
 * new-api 中文、raw Go 网络错)归一成稳定 code 枚举 + 官方状态码,同时消灭内部信息泄漏
 * (品牌名 / region 名 / 内部分组名 / tcp 地址)。对客错误码对照表:/docs#errors。
 *
 * 分桶原则(呼应 failover 错误分类硬约束):归类只发生在 new-api 重试/failover 全部打完之后的
 * 展示层,不改变重试语义;不确定的 4xx 走 default 桶原样透传(仅抹品牌名),宁可保留原文也不误改写。
 */

const OFFICIAL_TYPES = {
    invalidRequest: 'invalid_request_error',
    rateLimit: 'rate_limit_error',
    insufficientQuota: 'insufficient_quota',
    serverError: 'server_error',
    /** gpt-image 系审核拒绝的官方 type(社区多个原样样本;DALL·E 3 时代才是 invalid_request_error)。 */
    userError: 'user_error',
} as const;

function officialBody(message: string, type: string, code: string | null, param: string | null = null): string {
    return JSON.stringify({ error: { message, type, param, code } });
}

/** 真·内容审核拒绝的标记(上游确定性输入拒)。⚠️ 不含 `adobe` —— 仅提到品牌名的错误
 *  (如 adobe 线路超时)不是审核拒绝,冒充审核文案会误导客户排查方向(2026-08-05 错误
 *  报告 F 项)。`rejected ... safety system` 覆盖 azure 审核原文(线上实测以 500 出现过)。 */
export const IMAGE_SAFETY_RE =
    /image_unsafe|content rejected|appear to be unsafe|rejected (?:as a result of|by) (?:our|the) safety system/i;

/** 审核拒绝统一体 = 官方 gpt-image 系原文:400 `moderation_blocked` / type `user_error`
 *  (第 2 步切换;`content_policy_violation` 是 DALL·E 3 旧码,已随公告下线)。 */
export const IMAGE_SAFETY_BODY = officialBody(
    'Your request was rejected as a result of our safety system. Your request may contain content that is not allowed by our safety system.',
    OFFICIAL_TYPES.userError,
    'moderation_blocked',
);

// ── 分桶正则(顺序即优先级,safety 最先) ──
const QUOTA_RE = /insufficient[_ ]quota|quota is not enough|余额不足|额度不足/i;
const AUTH_RE = /invalid token|invalid api key|incorrect api key|无效的令牌|令牌.{0,6}(无效|过期|已禁用)/i;
const THROTTLE_RE =
    /throttled|rate.?limit|retry-after|system under load|concurrency limit exceeded|too many pending requests|bad response status code 408/i;
const UPSTREAM_BADREQ_RE =
    /invalid image file|invalid input image|unable to process input image|bad request to openai|validation_error|undefined mention|prompt is required/i;
const CAPACITY_RE =
    /no available channel|无可用渠道|temporarily unable to process|service temporarily unavailable|currently overloaded/i;
const TRANSIENT_RE =
    /temporary error|unexpected eof|context deadline exceeded|tls handshake|connection reset|connection timed out|read tcp|do request failed|upstream request failed|bad response status code \d+|http: server gave/i;

export interface NormalizedImageError {
    body: string;
    status: number;
    /** 限流类:建议退避秒数,调用方写 `Retry-After` 响应头。 */
    retryAfter?: number;
}

/** 从上游限流文案提取退避秒数(`retry-after=3s` / `try again in 3s`),提不到给 30。 */
function parseRetryAfter(text: string): number {
    const m = /(?:retry-after=|try again in )(\d+)/i.exec(text);
    const n = m ? Number(m[1]) : 0;
    return n > 0 && n <= 600 ? n : 30;
}

/** 转发上游图片错误给客户前统一归类 + 脱敏。内部 reqlog 仍记原文(调用方先 capture 再 normalize)。 */
export function normalizeImageError(text: string, upstreamStatus: number): NormalizedImageError {
    // 1. 内容审核 → 恒 400 moderation_blocked(号池个别成员把拒绝包在 HTTP 200 体里,透传 status
    //    会被客户网关按成功入账 —— 2026-08-08 客户反馈实例;azure 审核原文也出现过 500 形态)
    if (IMAGE_SAFETY_RE.test(text)) return { body: IMAGE_SAFETY_BODY, status: 400 };

    // 2. 余额不足(new-api 原生 403)→ 官方计费语义 429 insufficient_quota
    if (QUOTA_RE.test(text)) {
        return {
            body: officialBody(
                'You exceeded your current quota, please check your plan and billing details.',
                OFFICIAL_TYPES.insufficientQuota,
                'insufficient_quota',
            ),
            status: 429,
        };
    }

    // 3. key 无效/禁用 → 401(官方语义)
    if (AUTH_RE.test(text)) {
        return {
            body: officialBody('Incorrect API key provided.', OFFICIAL_TYPES.invalidRequest, 'invalid_api_key'),
            status: 401,
        };
    }

    // 4. 限流/并发(合并 we-token 408/429 系、并发守门、azure region 文案、`bad response status code 408`)
    //    → 429 + Retry-After(此前对客是 408,2026-08-18 公告切换)
    if (THROTTLE_RE.test(text)) {
        const retryAfter = parseRetryAfter(text);
        return {
            body: officialBody(
                `Rate limit reached for gpt-image-2. Please try again in ${retryAfter}s.`,
                OFFICIAL_TYPES.rateLimit,
                'rate_limit_exceeded',
            ),
            status: 429,
            retryAfter,
        };
    }

    // 5. 请求本身错(上游确定性输入拒,不再透传 we-token 嵌套 JSON)→ 恒 400
    //    (上游曾以 422/401/403 形态压平出现,统一 400 invalid_request_error)
    if (UPSTREAM_BADREQ_RE.test(text)) {
        if (/prompt is required/i.test(text)) {
            return {
                body: officialBody(
                    "Missing required parameter: 'prompt'.",
                    OFFICIAL_TYPES.invalidRequest,
                    'invalid_request',
                    'prompt',
                ),
                status: 400,
            };
        }
        if (/invalid image file|invalid input image|unable to process input image/i.test(text)) {
            // 多图 edits 保留出错的是第几张(`image 2`),客户能定位到具体素材
            const idx = /image (\d+)/i.exec(text)?.[1];
            return {
                body: officialBody(
                    `Invalid input image${idx ? ` (image ${idx})` : ''}. Please check that the image file is valid and in a supported format.`,
                    OFFICIAL_TYPES.invalidRequest,
                    'invalid_image',
                    'image',
                ),
                status: 400,
            };
        }
        return {
            body: officialBody(
                'Invalid request: the prompt, image, or parameters were rejected — please check your request.',
                OFFICIAL_TYPES.invalidRequest,
                'invalid_request',
            ),
            status: 400,
        };
    }

    // 6. 容量(new-api 无渠道 / 全线路 exhausted / 适配器守门透出)→ 503 overloaded
    if (CAPACITY_RE.test(text)) {
        return {
            body: officialBody(
                'The engine is currently overloaded, please try again later.',
                OFFICIAL_TYPES.serverError,
                null,
            ),
            status: 503,
        };
    }

    // 7. 上游临时错:显式特征(EOF / deadline / raw tcp / `bad response status code N`)或任何
    //    未识别的 5xx —— 一律 500 官方 server_error 体(此前对客散落 400/404/413/500/502/504;
    //    raw 网络错原文只留内部日志,不出门)
    if (TRANSIENT_RE.test(text) || upstreamStatus >= 500) {
        return {
            body: officialBody(
                'The server had an error while processing your request. Sorry about that! Please retry your request.',
                OFFICIAL_TYPES.serverError,
                null,
            ),
            status: 500,
        };
    }

    // 8. default:未识别的 4xx 原样透传(status 不动),仅抹上游品牌名(宁可保留原文也不误改写;
    //    分类 miss 靠内部日志按周 review 补正则)
    return { body: text.replace(/\badobe\b/gi, 'the provider'), status: upstreamStatus };
}

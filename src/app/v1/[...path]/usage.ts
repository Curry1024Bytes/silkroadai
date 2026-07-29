/**
 * GET /v1/usage — 客户机读【逐请求用量 + 实际扣费】端点(sk- key 鉴权)。
 *
 * 客户诉求:API 返回 token usage 跟实际扣费。token usage 响应体里本来就有
 * (OpenAI 形 `usage` 字段;流式加 `stream_options.include_usage`);但【实际扣费】
 * 是 new-api 请求结束后 post-flight 记账的,响应发出时账还没落 —— 没法放进响应本身。
 * 所以给查询式:响应头 `x-oneapi-request-id` ↔ 日志行 `request_id` 对账,
 * 本端点按 request_id 单查 / 按时间段批量拉,逐条返回 token 数 + 实际扣的 ¥/$。
 *
 * 与 /api/portal/logs(cookie 鉴权、网页版)同源同口径:queryLogs(/api/log/)、
 * username 主过滤 + user_id 二次防越权(gotcha #15:/api/log/ 忽略 user_id)、
 * 错误文案 sanitize、按张计费(生图 ModelPrice)时 token 数标注为噪声。
 * 区别:sk- 鉴权(脚本/服务端好接)、形态 OpenAI list 风格、金额直接给 ¥ + 真实 $。
 *
 * 语义:
 * - new-api 无 /v1/usage(纯透传时代 404)→ 拦截纯增量,零兼容风险;
 * - 与 /v1/balance、/v1/key 一致:beginCapture 之前拦截,不记请求日志、不限流
 *   (客户 API 不做限流是既定约束);
 * - 撤销/未知 key 一律 401;
 * - 默认只返回消费行(type=2);`type=error|refund|all` 可看失败/退款/全部;
 * - `key_only=true` 只看当前调用 key 自己的行(默认整个账户,便于对账);
 * - 扣费以 `cost_cny` 为准(= quota 换算 ¥);`cost_usd` 按真实汇率折算展示。
 *   按张计费的生图行 `billing='per_call'`,其 token 数是上游噪声、仅供参考。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { queryLogs, type NewApiUsageLog } from '@/lib/newapi/client';
import { quotaToCny, quotaToRealUsd } from '@/lib/newapi/quota-units';
import { sanitizeLogContent, isPerImageBilled } from '@/lib/newapi/log-display';

/** new-api /api/log/ 单页硬上限(gotcha:page_size 钳 100)。 */
const MAX_PAGE_SIZE = 100;

const QuerySchema = z.object({
    /** 单条对账:响应头 `x-oneapi-request-id` 的值。 */
    request_id: z
        .string()
        .trim()
        .max(80)
        .regex(/^[A-Za-z0-9]+$/)
        .optional(),
    /** 时间窗(unix 秒)。 */
    start_time: z.coerce.number().int().nonnegative().optional(),
    end_time: z.coerce.number().int().nonnegative().optional(),
    model: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    page_size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
    /** 只看当前 sk- 这把 key 的行(默认整个账户)。 */
    key_only: z.enum(['true', 'false']).default('false'),
    /** consume=成功扣费(默认)/ error=失败 / refund=退款 / all=全部。 */
    type: z.enum(['consume', 'error', 'refund', 'all']).default('consume'),
});

/** 端点自答的 log type 白名单 → new-api 数值。all → 0(全类型)后再收敛到 2/5/6
 *  (充值/管理行不属于调用对账,永不出参)。 */
const TYPE_TO_NEWAPI: Record<string, 0 | 2 | 5 | 6> = {
    consume: 2,
    error: 5,
    refund: 6,
    all: 0,
};
const VISIBLE_TYPES = new Set([2, 5, 6]);
const TYPE_LABEL: Record<number, string> = { 2: 'consume', 5: 'error', 6: 'refund' };

/** OpenAI 形错误(与 /v1/balance、/v1/key 的 billingError 同形)。 */
function usageError(message: string, status: number): NextResponse {
    return NextResponse.json({ error: { message, type: 'new_api_error', code: '' } }, { status });
}

const round6 = (n: number) => Number(n.toFixed(6));

function toUsageRow(log: NewApiUsageLog) {
    const perCall = isPerImageBilled(log.other, log.model_name);
    return {
        request_id: log.request_id,
        created_at: log.created_at, // unix 秒(UTC)
        type: TYPE_LABEL[log.type] ?? String(log.type),
        model: log.model_name,
        token_name: log.token_name,
        is_stream: log.is_stream,
        duration_ms: log.use_time * 1000, // new-api use_time 是【秒】
        usage: {
            prompt_tokens: log.prompt_tokens,
            completion_tokens: log.completion_tokens,
            total_tokens: log.prompt_tokens + log.completion_tokens,
        },
        /** per_call = 按次/按张计费(生图 ModelPrice),token 数是上游噪声仅供参考;
         *  per_token = 按 token 计费,usage 就是计费依据。 */
        billing: perCall ? 'per_call' : 'per_token',
        /** 实际扣费(权威值,来自 new-api 记账;refund 行为负数含义=退回)。 */
        cost_cny: round6(quotaToCny(log.quota)),
        cost_usd: round6(quotaToRealUsd(log.quota)),
        /** 原始 quota(500k = ¥1),对账脚本想自己换算时用。 */
        quota: log.quota,
        /** 计费说明 / 失败原因(错误行已脱敏)。 */
        content: sanitizeLogContent(log.content),
    };
}

export async function handleUsageQuery(req: NextRequest): Promise<NextResponse> {
    const auth = req.headers.get('authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return usageError('Missing bearer token', 401);
    const raw = m[1].trim();
    const stored = raw.startsWith('sk-') ? raw.slice(3) : raw; // DB 存无 sk- 前缀(token-format.ts)

    const token = await prisma.newApiToken.findUnique({
        where: { newapi_token_value: stored },
        select: {
            status: true,
            newapi_token_id: true,
            user: { select: { newapi_user_id: true, newapi_username: true } },
        },
    });
    if (!token || token.status !== 'active') return usageError('Invalid token', 401);
    if (token.user.newapi_user_id == null || token.user.newapi_username == null) {
        return usageError('account not provisioned', 503);
    }

    const parsed = QuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) {
        const detail = parsed.error.issues[0];
        return usageError(`invalid query param${detail ? ` '${detail.path.join('.')}': ${detail.message}` : 's'}`, 400);
    }
    const q = parsed.data;
    const newapiUserId = token.user.newapi_user_id;

    let items: NewApiUsageLog[];
    try {
        const res = await queryLogs({
            username: token.user.newapi_username,
            user_id: newapiUserId,
            type: TYPE_TO_NEWAPI[q.type],
            start_timestamp: q.start_time,
            end_timestamp: q.end_time,
            model_name: q.model,
            request_id: q.request_id,
            page: q.page,
            page_size: q.page_size,
        });
        items = res.items;
    } catch (err) {
        console.warn('[v1-usage] queryLogs failed', {
            err: err instanceof Error ? err.message : String(err),
        });
        return usageError('usage temporarily unavailable', 503);
    }

    // IDOR 二次过滤(username 是真正生效的过滤维度,user_id 兜底防越权)+ 收敛到调用行
    let mine = items.filter((l) => l.user_id === newapiUserId && VISIBLE_TYPES.has(l.type));
    if (q.key_only === 'true') mine = mine.filter((l) => l.token_id === token.newapi_token_id);

    // request_id 单查且没命中:大概率是账还没落(post-flight 记账,通常 1-2 秒内)——
    // 用 404 + 明确文案让脚本知道可以稍后重试,而不是拿到空 list 误以为免费。
    if (q.request_id && mine.length === 0) {
        return usageError(
            'request_id not found (billing log may lag a few seconds after the response; retry shortly)',
            404,
        );
    }

    return NextResponse.json({
        object: 'list',
        data: mine.sort((a, b) => b.created_at - a.created_at).map(toUsageRow),
        page: q.page,
        page_size: q.page_size,
        // 满页 = 大概率还有下一页(按 new-api 原始页翻;post-filter 后本页可能 < page_size)
        has_more: items.length >= q.page_size,
    });
}

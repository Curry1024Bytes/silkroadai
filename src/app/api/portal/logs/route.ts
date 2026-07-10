/**
 * /api/portal/logs — 客户「调用日志」页的数据源(GET,cookie 鉴权)。
 *
 * 相比 dashboard 那个"最近调用"小表(有界一次拉、客户端翻页),这里做全功能日志:
 *   - 按【日期范围】查(start/end unix 秒)
 *   - 按 Request ID / 令牌名 / 模型名 / 渠道 分类搜索(new-api /api/log/ 实测均支持精确过滤)
 *   - 服务端分页(new-api /api/log/ page_size 硬钳 100,故一页 = 100 原始行)
 *
 * 只显示【API 调用】:type=2 成功 + type=5 失败(充值/管理等其它 type 过滤掉,充值在「充值流水」)。
 * 折叠 + 脱敏复用 log-display:failover / 重试的中间失败(同 request_id 有成功、或 size-must-use +
 * 邻近成功)藏掉 —— 客户不被"重试成功的失败过程"刷屏;错误文案脱敏隐藏 adobe 等上游来源。
 *
 * 安全:username 是 admin 下真正生效的过滤维度(gotcha #15,/api/log/ 忽略 user_id),但仍按
 * user_id 二次过滤防越权(万一 username 不唯一/被忽略,不泄漏他人日志)。原始 content 经 sanitize
 * 后才出参,不进浏览器。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth/session';
import { queryLogs, quotaToCny, type NewApiUsageLog } from '@/lib/newapi/client';
import { collapseRetriedFailures, sanitizeLogContent } from '@/lib/newapi/log-display';

export const runtime = 'nodejs';

/** new-api /api/log/ 单页硬上限。 */
const PAGE_SIZE = 100;

const QuerySchema = z.object({
    start: z.coerce.number().int().nonnegative().optional(),
    end: z.coerce.number().int().nonnegative().optional(),
    model: z.string().trim().max(100).optional(),
    token: z.string().trim().max(100).optional(),
    request_id: z
        .string()
        .trim()
        .max(80)
        .regex(/^[A-Za-z0-9]*$/)
        .optional(),
    channel: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
});

/** 一行日志(与 dashboard CallRow 同形,复用同套 format 展示)。 */
export interface LogRow {
    id: number;
    createdAt: number;
    model: string;
    tokenName: string;
    requestId: string;
    useTimeMs: number;
    promptTokens: number;
    completionTokens: number;
    quota: number;
    costCny: number;
    type: number;
    content: string;
}

function toLogRow(log: NewApiUsageLog): LogRow {
    return {
        id: log.id,
        createdAt: log.created_at,
        model: log.model_name,
        tokenName: log.token_name,
        requestId: log.request_id,
        useTimeMs: log.use_time * 1000, // new-api use_time 是【秒】
        promptTokens: log.prompt_tokens,
        completionTokens: log.completion_tokens,
        quota: log.quota,
        costCny: quotaToCny(log.quota),
        type: log.type,
        content: sanitizeLogContent(log.content), // 脱敏后才出参
    };
}

export async function GET(req: NextRequest) {
    const user = await getCurrentUser(req);
    if (!user) return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
    if (user.newapi_user_id == null || user.newapi_username == null) {
        return NextResponse.json({ rows: [], page: 1, hasMore: false, error: 'account_not_provisioned' });
    }

    const parsed = QuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_params' }, { status: 400 });
    const q = parsed.data;
    const newapiUserId = user.newapi_user_id;

    let items: NewApiUsageLog[];
    try {
        const res = await queryLogs({
            username: user.newapi_username,
            user_id: newapiUserId,
            type: 0, // 全类型一次拉,含 2+5(failover 的失败+成功同页相邻,页内折叠正确)
            start_timestamp: q.start,
            end_timestamp: q.end,
            model_name: q.model || undefined,
            token_name: q.token || undefined,
            request_id: q.request_id || undefined,
            channel: q.channel,
            page: q.page,
            page_size: PAGE_SIZE,
        });
        items = res.items;
    } catch (e) {
        console.warn(`[portal/logs] queryLogs failed for user ${user.id}:`, e);
        return NextResponse.json({ rows: [], page: q.page, hasMore: false, error: 'fetch_failed' });
    }

    // IDOR 二次过滤 + 只留 API 调用(成功 2 / 失败 5)
    const mine = items.filter((l) => l.user_id === newapiUserId && (l.type === 2 || l.type === 5));
    const consume = mine.filter((l) => l.type === 2);
    const errors = mine.filter((l) => l.type === 5);
    const visibleErrors = collapseRetriedFailures(consume, errors);
    const rows: LogRow[] = [...consume, ...visibleErrors].sort((a, b) => b.created_at - a.created_at).map(toLogRow);

    // 满页(拿满 100 原始行)= 大概率还有下一页。折叠后 rows 可能 <100,但翻页按 new-api 原始页走。
    return NextResponse.json({ rows, page: q.page, hasMore: items.length >= PAGE_SIZE });
}

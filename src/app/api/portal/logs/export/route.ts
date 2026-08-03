/**
 * /api/portal/logs/export — 客户「调用日志」CSV 导出(GET,cookie 鉴权)。
 *
 * 与 /api/portal/logs 同一套过滤条件(日期范围 + Request ID / 令牌 / 模型 / 渠道)。
 *
 * 两条数据路径:
 *   1.【主路径:全量,无行数上限】new-api 日志库只读直连(`getNewapiLogsPool`,同 admin
 *      logs-export 的基建):keyset 分页(id 游标,新→旧)+ ReadableStream 边查边吐,
 *      几十万行也不把行全量攒在内存。折叠规则直接下推到 SQL(见 WHERE 注释)。
 *   2.【回退:未配置 NEWAPI_LOGS_DATABASE_URL 的环境(本地 dev)】按 new-api /api/log/
 *      的 100 行硬钳循环翻页,上限 MAX_EXPORT_PAGES × 100 = 10000 行,触顶时 CSV 末尾
 *      追加提示行 + `X-Export-Truncated: 1`(原行为,防把 new-api API 拖垮)。
 *
 * 行为与日志页保持一致:只导 API 调用(type=2 成功 + type=5 失败)、IDOR 按 user_id
 * 过滤、failover / 重试的中间失败折叠、错误文案脱敏(gotcha #15 + log-display)。
 * 时间列一律 Asia/Shanghai(gotcha #20)。
 *
 * CSV 细节:UTF-8 BOM(Excel 中文不乱码);含逗号/引号/换行的字段加引号转义;以
 * `=`/`+`/`-`/`@` 开头的文本字段前置 `'` 防公式注入(错误详情来自上游,不可信)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { Pool } from 'pg';
import { getCurrentUser } from '@/lib/auth/session';
import { queryLogs, quotaToCny, type NewApiUsageLog } from '@/lib/newapi/client';
import { getNewapiLogsPool } from '@/lib/newapi/logs-db';
import {
    collapseRetriedFailures,
    sanitizeLogContent,
    isPerImageBilled,
    parseCacheTokens,
} from '@/lib/newapi/log-display';

export const runtime = 'nodejs';

/** new-api /api/log/ 单页硬上限(回退路径用)。 */
const PAGE_SIZE = 100;
/** 回退路径单次导出最多翻的页数(× PAGE_SIZE = 10000 原始行)。 */
const MAX_EXPORT_PAGES = 100;
/** 主路径(DB 直连)每批行数 —— 只是流式批粒度,不是导出上限。 */
const DB_BATCH_SIZE = 5_000;

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
});

const HEADER = [
    '时间(北京)',
    '模型',
    '令牌(Key)',
    'Request ID',
    '时长(秒)',
    '输入 Tokens',
    '输出 Tokens',
    '缓存读 Tokens',
    '缓存写 Tokens',
    '消耗(元)',
    '结果',
    '详情',
];

/** 触顶提示(仅回退路径;放进 CSV 末行第一列,客户打开文件就能看到)。 */
const TRUNCATED_NOTE = `已达单次导出上限 ${MAX_EXPORT_PAGES * PAGE_SIZE} 条,未包含更早记录;请缩小日期范围后分次导出`;

/** 北京时间 `YYYY-MM-DD HH:mm:ss`(sv-SE locale 恰好是这个形态)。 */
const BEIJING_TIME = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
});

/** 单元格转义:防公式注入(不可信文本)+ 标准 CSV 引号规则。 */
function csvCell(value: string | number): string {
    let s = String(value);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
}

/** toCsvRow 实际用到的字段子集 —— HTTP 面(NewApiUsageLog)与 DB 直读行都满足。 */
type CsvSourceLog = Pick<
    NewApiUsageLog,
    | 'created_at'
    | 'model_name'
    | 'token_name'
    | 'request_id'
    | 'use_time'
    | 'prompt_tokens'
    | 'completion_tokens'
    | 'quota'
    | 'type'
    | 'content'
    | 'other'
>;

function toCsvRow(log: CsvSourceLog): string {
    const perImage = isPerImageBilled(log.other, log.model_name);
    const cache = parseCacheTokens(log.other);
    return [
        BEIJING_TIME.format(new Date(log.created_at * 1000)),
        log.model_name || '',
        log.token_name || '',
        log.request_id || '',
        log.use_time, // new-api use_time 是【秒】
        // 按张计费(生图 ModelPrice)时 token 是噪声,与日志页 "—" 同语义 → 留空
        perImage ? '' : log.prompt_tokens,
        perImage ? '' : log.completion_tokens,
        // 缓存读写与页面同语义:按张计费留空;0 也如实写 0(CSV 是对账口径,不藏)
        perImage ? '' : cache.read,
        perImage ? '' : cache.write,
        quotaToCny(log.quota).toFixed(4),
        log.type === 5 ? '失败' : '成功',
        log.type === 5 ? sanitizeLogContent(log.content) : '',
    ]
        .map(csvCell)
        .join(',');
}

function csvResponseHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const stamp = BEIJING_TIME.format(new Date()).replace(/[-: ]/g, '').slice(0, 12); // YYYYMMDDHHmm
    return {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="llmroute-logs-${stamp}.csv"`,
        'Cache-Control': 'no-store',
        ...extra,
    };
}

/** DB 直读行(pg int8 默认回字符串,数值字段统一 Number() 后再进 toCsvRow)。 */
interface DbLogRow {
    id: string;
    created_at: string;
    model_name: string | null;
    token_name: string | null;
    request_id: string | null;
    use_time: string;
    prompt_tokens: string;
    completion_tokens: string;
    quota: string;
    type: string;
    content: string | null;
    other: string | null;
}

/**
 * 主路径:日志库直读,keyset 流式,全量无上限。
 *
 * 折叠规则下推到 SQL(与 log-display.collapseRetriedFailures 同语义,但作用于
 * 【整个筛选范围】而不是单页 —— 比回退路径更准):
 *   规则 1(failover 中间失败):type=5 且同 request_id 存在 type=2 成功 → 藏;
 *   规则 2(proxy 尺寸重试):type=5 且 content 含 "size must use" 且 180s 内有成功 → 藏。
 * 两条 EXISTS 分别吃 idx_logs_request_id / idx_created_at_type,失败行占比小,代价可控。
 */
function exportFromLogsDb(pool: Pool, newapiUserId: number, q: z.infer<typeof QuerySchema>): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            // 独占一条连接跑全程并 SET jit=off:这条复杂 WHERE 的 PG JIT 编译开销 ~800ms/批,
            // 关掉后实测 16ms/批(prod 770 万行客户 EXPLAIN ANALYZE 对比),全量导出从几十分钟
            // 降到几十秒。SET 是 session 级,必须钉在同一连接上,不能用 pool.query(随机连接)。
            const client = await pool.connect();
            try {
                await client.query('SET jit = off');
                controller.enqueue(encoder.encode('\uFEFF' + HEADER.map(csvCell).join(',') + '\r\n'));
                let lastId = '9223372036854775807'; // int8 max,新→旧(与日志页一致)
                for (;;) {
                    const { rows } = await client.query<DbLogRow>(
                        `SELECT id::text AS id, created_at, model_name, token_name, request_id,
                                use_time, prompt_tokens, completion_tokens, quota, type, content, other
                           FROM logs l
                          WHERE l.user_id = $1
                            AND l.type IN (2, 5)
                            AND ($2::bigint IS NULL OR l.created_at >= $2)
                            AND ($3::bigint IS NULL OR l.created_at <= $3)
                            AND ($4::text   IS NULL OR l.model_name = $4)
                            AND ($5::text   IS NULL OR l.token_name = $5)
                            AND ($6::text   IS NULL OR l.request_id = $6)
                            AND ($7::bigint IS NULL OR l.channel_id = $7)
                            AND NOT (l.type = 5 AND l.request_id <> '' AND EXISTS (
                                    SELECT 1 FROM logs s
                                     WHERE s.request_id = l.request_id
                                       AND s.user_id = l.user_id AND s.type = 2))
                            AND NOT (l.type = 5 AND l.content ILIKE '%size must use%' AND EXISTS (
                                    SELECT 1 FROM logs s2
                                     WHERE s2.user_id = l.user_id AND s2.type = 2
                                       AND s2.created_at >= l.created_at
                                       AND s2.created_at <= l.created_at + 180))
                            AND l.id < $8
                          ORDER BY l.id DESC
                          LIMIT $9`,
                        [
                            newapiUserId,
                            q.start ?? null,
                            q.end ?? null,
                            q.model || null,
                            q.token || null,
                            q.request_id || null,
                            q.channel ?? null,
                            lastId,
                            DB_BATCH_SIZE,
                        ],
                    );
                    if (rows.length === 0) break;
                    let chunk = '';
                    for (const r of rows) {
                        chunk +=
                            toCsvRow({
                                created_at: Number(r.created_at),
                                model_name: r.model_name ?? '',
                                token_name: r.token_name ?? '',
                                request_id: r.request_id ?? '',
                                use_time: Number(r.use_time),
                                prompt_tokens: Number(r.prompt_tokens),
                                completion_tokens: Number(r.completion_tokens),
                                quota: Number(r.quota),
                                type: Number(r.type) as NewApiUsageLog['type'],
                                content: r.content ?? '',
                                other: r.other ?? '',
                            }) + '\r\n';
                    }
                    controller.enqueue(encoder.encode(chunk));
                    lastId = rows[rows.length - 1].id;
                    if (rows.length < DB_BATCH_SIZE) break;
                }
                controller.close();
            } catch (err) {
                console.warn('[portal/logs/export] logs-db stream failed', {
                    newapiUserId,
                    err: err instanceof Error ? err.message : String(err),
                });
                controller.error(err);
            } finally {
                client.release();
            }
        },
    });
    return new Response(stream, { headers: csvResponseHeaders() });
}

/** 回退路径:new-api HTTP API 循环翻页(100 行/页,上限 10000 行)。 */
async function exportViaHttpPaging(
    user: { id: string; newapi_username: string },
    newapiUserId: number,
    q: z.infer<typeof QuerySchema>,
): Promise<NextResponse> {
    const items: NewApiUsageLog[] = [];
    let truncated = false;
    try {
        for (let page = 1; page <= MAX_EXPORT_PAGES; page++) {
            const res = await queryLogs({
                username: user.newapi_username,
                user_id: newapiUserId,
                type: 0, // 全类型一次拉,含 2+5(failover 的失败+成功相邻,折叠正确)
                start_timestamp: q.start,
                end_timestamp: q.end,
                model_name: q.model || undefined,
                token_name: q.token || undefined,
                request_id: q.request_id || undefined,
                channel: q.channel,
                page,
                page_size: PAGE_SIZE,
            });
            items.push(...res.items);
            if (res.items.length < PAGE_SIZE) break;
            if (page === MAX_EXPORT_PAGES) truncated = true;
        }
    } catch (e) {
        console.warn(`[portal/logs/export] queryLogs failed for user ${user.id}:`, e);
        return NextResponse.json({ error: 'fetch_failed' }, { status: 502 });
    }

    // 与 /api/portal/logs 同一套:IDOR 二次过滤 + 只留 API 调用 + 折叠重试中间失败
    const mine = items.filter((l) => l.user_id === newapiUserId && (l.type === 2 || l.type === 5));
    const consume = mine.filter((l) => l.type === 2);
    const errors = mine.filter((l) => l.type === 5);
    const visibleErrors = collapseRetriedFailures(consume, errors);
    const rows = [...consume, ...visibleErrors].sort((a, b) => b.created_at - a.created_at).map(toCsvRow);
    if (truncated) rows.push(csvCell(TRUNCATED_NOTE));

    // UTF-8 BOM keeps Chinese column names readable in Excel; \r\n supports Windows Excel.
    const csv = '\uFEFF' + [HEADER.map(csvCell).join(','), ...rows].join('\r\n') + '\r\n';
    return new NextResponse(csv, { headers: csvResponseHeaders(truncated ? { 'X-Export-Truncated': '1' } : {}) });
}

export async function GET(req: NextRequest) {
    const user = await getCurrentUser(req);
    if (!user) return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
    if (user.newapi_user_id == null || user.newapi_username == null) {
        return NextResponse.json({ error: 'account_not_provisioned' }, { status: 400 });
    }

    const parsed = QuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_params' }, { status: 400 });
    const q = parsed.data;
    const newapiUserId = user.newapi_user_id;

    // 主路径:日志库直连(全量);未配置的环境回退 HTTP 翻页(10000 行上限)。
    const pool = getNewapiLogsPool();
    if (pool) return exportFromLogsDb(pool, newapiUserId, q);
    return exportViaHttpPaging({ id: user.id, newapi_username: user.newapi_username }, newapiUserId, q);
}

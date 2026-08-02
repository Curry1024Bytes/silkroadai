/**
 * /api/portal/logs/export — 客户「调用日志」CSV 导出(GET,cookie 鉴权)。
 *
 * 与 /api/portal/logs 同一套过滤条件(日期范围 + Request ID / 令牌 / 模型 / 渠道),
 * 但不分页 —— 服务端按 new-api /api/log/ 的 100 行硬钳循环翻页,把整个筛选范围拉全
 * 后一次性生成 CSV 下载。单次导出上限 MAX_EXPORT_PAGES × 100 原始行,防止 `all`
 * 这类超大范围把 new-api 拖垮;触顶时 CSV 末尾追加提示行 + `X-Export-Truncated: 1`。
 *
 * 行为与日志页保持一致:只导 API 调用(type=2 成功 + type=5 失败)、IDOR 按 user_id
 * 二次过滤、failover / 重试的中间失败折叠、错误文案脱敏(gotcha #15 + log-display)。
 * 时间列一律 Asia/Shanghai(gotcha #20)。
 *
 * CSV 细节:UTF-8 BOM(Excel 中文不乱码);含逗号/引号/换行的字段加引号转义;以
 * `=`/`+`/`-`/`@` 开头的文本字段前置 `'` 防公式注入(错误详情来自上游,不可信)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth/session';
import { queryLogs, quotaToCny, type NewApiUsageLog } from '@/lib/newapi/client';
import {
    collapseRetriedFailures,
    sanitizeLogContent,
    isPerImageBilled,
    parseCacheTokens,
} from '@/lib/newapi/log-display';

export const runtime = 'nodejs';

/** new-api /api/log/ 单页硬上限。 */
const PAGE_SIZE = 100;
/** 单次导出最多翻的页数(× PAGE_SIZE = 10000 原始行)。 */
const MAX_EXPORT_PAGES = 100;

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

/** 触顶提示(放进 CSV 末行第一列,客户打开文件就能看到)。 */
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

function toCsvRow(log: NewApiUsageLog): string {
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

    // 循环翻页拉全量(new-api page_size 硬钳 100 → 只能逐页拉),不满页即为最后一页。
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

    // \ufeff = UTF-8 BOM,Excel 打开中文表头不乱码;\r\n 兼容 Windows Excel。
    const csv = '\ufeff' + [HEADER.map(csvCell).join(','), ...rows].join('\r\n') + '\r\n';
    const stamp = BEIJING_TIME.format(new Date()).replace(/[-: ]/g, '').slice(0, 12); // YYYYMMDDHHmm
    return new NextResponse(csv, {
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="silkroadai-logs-${stamp}.csv"`,
            'Cache-Control': 'no-store',
            ...(truncated ? { 'X-Export-Truncated': '1' } : {}),
        },
    });
}

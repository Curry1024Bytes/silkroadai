import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { quotaToCny } from '@/lib/newapi/client';
import { getNewapiLogsPool } from '@/lib/newapi/logs-db';

export const runtime = 'nodejs';

/**
 * GET /api/admin/customers/[id]/logs-export — 客户调用日志 CSV 导出(任意时段)。
 *
 * ?start=YYYY-MM-DD&end=YYYY-MM-DD[&model=xxx]
 * 天界按北京时间(gotcha #20):start 当天 00:00(含)→ end 次日 00:00(不含)。
 *
 * 数据源 = new-api 日志库只读直连(见 src/lib/newapi/logs-db.ts 头注释:
 * /api/log/ page_size 钳 100,重度客户几十万行走 API 不可行)。keyset 分页
 * (id 游标)+ ReadableStream 边查边吐,几十万行也不会把行全量攒在内存里。
 *
 * 导出列 = 客户可见字段(时间/模型/tokens/耗时/quota/¥),刻意不含 IP、
 * request_id、渠道、分组、倍率 —— 这份 CSV 会被直接转发给客户,不能带内部信息。
 * 只导 type=2(计费成功);失败调用(type=5)与充值入账(type=3)不属于账单。
 *
 * ⚠️ IDOR:按 id 查 user 必带 tenantScope(admin),跨租户 → 404(镜像 newapi-usage)。
 */
const BATCH_SIZE = 5_000;
const MAX_RANGE_DAYS = 366;

const querySchema = z
    .object({
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'start 必须是 YYYY-MM-DD'),
        end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'end 必须是 YYYY-MM-DD'),
        model: z.string().min(1).max(128).optional(),
    })
    .refine((q) => q.start <= q.end, { message: 'start 不能晚于 end' });

/** 北京时间当天 00:00 的 epoch 秒。日期串已过 zod 正则,Date.parse 恒有效。 */
function beijingDayStartTs(date: string): number {
    return Math.floor(Date.parse(`${date}T00:00:00+08:00`) / 1_000);
}

const CSV_HEADER = '时间(北京),模型,输入tokens,输出tokens,耗时(秒),消耗quota,消耗(¥)\n';

/** RFC4180:含逗号/引号/换行的字段包双引号,内部双引号翻倍。 */
function csvField(v: string): string {
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

interface LogRow {
    id: string; // pg bigint → string
    time_beijing: string;
    model_name: string;
    prompt_tokens: number;
    completion_tokens: number;
    use_time: number;
    quota: number;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;
    const sp = request.nextUrl.searchParams;
    const parsed = querySchema.safeParse({
        start: sp.get('start') ?? '',
        end: sp.get('end') ?? '',
        model: sp.get('model') || undefined,
    });
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues[0]?.message ?? '参数无效' }, { status: 400 });
    }
    const { start, end, model } = parsed.data;

    const startTs = beijingDayStartTs(start);
    const endTs = beijingDayStartTs(end) + 86_400; // end 当天全天(次日 00:00 不含)
    if (endTs - startTs > MAX_RANGE_DAYS * 86_400) {
        return NextResponse.json({ error: `时段不能超过 ${MAX_RANGE_DAYS} 天` }, { status: 400 });
    }

    const user = await prisma.user.findFirst({
        where: { id, ...tenantScope(admin) },
        select: { id: true, newapi_user_id: true, newapi_username: true },
    });
    if (!user) return NextResponse.json({ error: '客户不存在' }, { status: 404 });
    if (user.newapi_user_id == null) {
        return NextResponse.json({ error: '该客户未绑定 new-api 账号' }, { status: 400 });
    }
    const nuid = user.newapi_user_id;

    const pool = getNewapiLogsPool();
    if (!pool) {
        return NextResponse.json({ error: '未配置 NEWAPI_LOGS_DATABASE_URL,日志导出不可用' }, { status: 503 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                // BOM 让 Excel 直接双击打开时按 UTF-8 识别中文表头
                controller.enqueue(encoder.encode('\uFEFF' + CSV_HEADER));
                let lastId = '0';
                for (;;) {
                    const { rows } = await pool.query<LogRow>(
                        `SELECT id,
                                to_char(to_timestamp(created_at) AT TIME ZONE 'Asia/Shanghai',
                                        'YYYY-MM-DD HH24:MI:SS') AS time_beijing,
                                model_name, prompt_tokens, completion_tokens, use_time, quota
                           FROM logs
                          WHERE user_id = $1 AND type = 2
                            AND created_at >= $2 AND created_at < $3
                            AND ($4::text IS NULL OR model_name = $4)
                            AND id > $5
                          ORDER BY id
                          LIMIT $6`,
                        [nuid, startTs, endTs, model ?? null, lastId, BATCH_SIZE],
                    );
                    if (rows.length === 0) break;
                    let chunk = '';
                    for (const r of rows) {
                        const quota = Number(r.quota);
                        chunk +=
                            `${r.time_beijing},${csvField(r.model_name)},${r.prompt_tokens},` +
                            `${r.completion_tokens},${r.use_time},${quota},${quotaToCny(quota).toFixed(4)}\n`;
                    }
                    controller.enqueue(encoder.encode(chunk));
                    lastId = rows[rows.length - 1].id;
                    if (rows.length < BATCH_SIZE) break;
                }
                controller.close();
            } catch (err) {
                console.warn('[admin/customers/logs-export] query failed', {
                    customerId: id,
                    newapiUserId: nuid,
                    err: err instanceof Error ? err.message : String(err),
                });
                controller.error(err);
            }
        },
    });

    const filename = `logs_${user.newapi_username ?? nuid}_${start}_${end}.csv`;
    return new Response(stream, {
        headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${filename}"`,
            'cache-control': 'no-store',
        },
    });
}

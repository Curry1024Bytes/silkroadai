import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveEnterpriseAdmin } from '@/lib/enterprise/admin-auth';
import { buildReqlogWhere } from '@/lib/enterprise/request-log';
import { toCsv, bjTimeStr } from '@/lib/enterprise/query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXPORT_CAP = 50_000;

/**
 * GET /api/admin/enterprise/logs/export — 请求日志 CSV 导出(运营后台 /enterprise-admin/logs)。
 * 筛选参数与列表页一致(buildReqlogWhere 共用);UTF-8 BOM 防 Excel 中文乱码。
 * body 列不进 CSV(单行 32KB 会把表格撑爆),要看原文走详情页 / 单条 JSON 下载。
 * 守门:superadmin(session 或 break-glass token)。
 */
export async function GET(request: NextRequest) {
    const admin = await resolveEnterpriseAdmin(request);
    if (!admin) return unauthorizedResponse(request);

    const sp = request.nextUrl.searchParams;
    const where = buildReqlogWhere({
        from: sp.get('from'),
        to: sp.get('to'),
        user: sp.get('user'),
        region: sp.get('region'),
        kind: sp.get('kind'),
        model: sp.get('model'),
        result: sp.get('result'),
        q: sp.get('q'),
    });

    const logs = await prisma.enterpriseRequestLog.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: EXPORT_CAP + 1,
        select: {
            created_at: true,
            kind: true,
            format: true,
            user_id: true,
            region: true,
            model: true,
            task_id: true,
            vendor_task_id: true,
            client_request_id: true,
            action: true,
            resource_id: true,
            http_status: true,
            upstream_status: true,
            cache_hit: true,
            outcome: true,
            error_code: true,
            error_message: true,
            duration_ms: true,
            upstream_ms: true,
            client_ip: true,
        },
    });
    if (logs.length > EXPORT_CAP) {
        return NextResponse.json(
            { error: 'too_many_rows', detail: `超过 ${EXPORT_CAP.toLocaleString()} 条,请缩小日期范围分批导出` },
            { status: 400 },
        );
    }

    const userIds = [...new Set(logs.map((l) => l.user_id).filter((v): v is string => v != null))];
    const users = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true },
    });
    const emailById = new Map(users.map((u) => [u.id, u.email]));

    const rows = logs.map((l) => [
        bjTimeStr(l.created_at),
        l.kind,
        l.format ?? '',
        l.user_id ? (emailById.get(l.user_id) ?? l.user_id) : '',
        l.region ?? '',
        l.model ?? '',
        l.task_id ?? '',
        l.vendor_task_id ?? '',
        l.client_request_id ?? '',
        l.action ?? '',
        l.resource_id ?? '',
        l.http_status ?? '',
        l.upstream_status ?? '',
        l.cache_hit ? '是' : '',
        l.outcome ?? '',
        l.error_code ?? '',
        l.error_message ?? '',
        l.duration_ms ?? '',
        l.upstream_ms ?? '',
        l.client_ip ?? '',
    ]);
    const csv = toCsv(
        [
            '时间(北京)',
            '类型',
            '接口面',
            '客户',
            '渠道',
            '模型',
            '任务ID',
            '渠道侧任务ID',
            '客户请求号',
            '素材Action',
            '素材ID',
            'HTTP',
            '上游HTTP',
            '缓存命中',
            '结果',
            '错误码',
            '错误信息',
            '总耗时ms',
            '上游耗时ms',
            '客户IP',
        ],
        rows,
    );
    const stamp = bjTimeStr(new Date()).slice(0, 10);
    return new NextResponse(csv, {
        status: 200,
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="enterprise-request-logs-${stamp}.csv"`,
        },
    });
}

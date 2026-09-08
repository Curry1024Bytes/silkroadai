import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveEnterpriseAdmin } from '@/lib/enterprise/admin-auth';
import { toCsv, bjTimeStr, parseDay } from '@/lib/enterprise/query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXPORT_CAP = 50_000;

/**
 * GET /api/admin/enterprise/audit/export — 管理员操作审计 CSV 导出(2026-09-04)。
 * 筛选与 /enterprise-admin/audit 列表页一致。守门:superadmin-only(监督面)。
 */
export async function GET(request: NextRequest) {
    const admin = await resolveEnterpriseAdmin(request, { superOnly: true });
    if (!admin) return unauthorizedResponse(request);

    const sp = request.nextUrl.searchParams;
    const from = parseDay(sp.get('from'));
    const to = parseDay(sp.get('to'), true);
    const adminId = sp.get('admin');
    const action = sp.get('action');
    const where = {
        ...(from || to ? { created_at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        ...(adminId && /^[0-9a-f-]{36}$/i.test(adminId) ? { admin_user_id: adminId } : {}),
        ...(action ? { action: { contains: action.slice(0, 64) } } : {}),
    };

    const rows = await prisma.adminAuditLog.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: EXPORT_CAP + 1,
    });
    if (rows.length > EXPORT_CAP) {
        return NextResponse.json(
            { error: 'too_many_rows', detail: `超过 ${EXPORT_CAP.toLocaleString()} 条,请缩小日期范围分批导出` },
            { status: 400 },
        );
    }

    const csv = toCsv(
        ['时间(北京)', '管理员', '等级', '操作', '目标', '方法', '路径', '参数', 'IP'],
        rows.map((l) => [
            bjTimeStr(l.created_at),
            l.admin_email ?? (l.level === 'break_glass' ? 'break-glass' : (l.admin_user_id ?? '')),
            l.level,
            l.action,
            l.target ?? '',
            l.method,
            l.path,
            l.params ?? '',
            l.client_ip ?? '',
        ]),
    );
    const stamp = bjTimeStr(new Date()).slice(0, 10);
    return new NextResponse(csv, {
        status: 200,
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="admin-audit-${stamp}.csv"`,
        },
    });
}

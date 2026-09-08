import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireEnterpriseUser } from '@/lib/enterprise/session';
import { parseDay, toCsv, bjTimeStr } from '@/lib/enterprise/query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXPORT_CAP = 50_000;

const KIND_LABEL: Record<string, string> = {
    recharge: '充值',
    charge: '消费',
    adjustment: '调整',
    migration: '迁移',
};

/**
 * GET /api/enterprise/export/billing?from=&to=&kind= — 计费流水 CSV 导出(2026-07-26)。
 * cookie session 守门;筛选与流水页一致。
 */
export async function GET(req: NextRequest) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const account = await prisma.account.findUnique({ where: { user_id: user.id }, select: { id: true } });
    if (!account) {
        return new NextResponse(toCsv(['时间(北京)', '类型', '金额(¥)', '余额快照(¥)', '备注'], []), {
            headers: { 'Content-Type': 'text/csv; charset=utf-8' },
        });
    }

    const sp = req.nextUrl.searchParams;
    const from = parseDay(sp.get('from'));
    const to = parseDay(sp.get('to'), true);
    const kind = ['recharge', 'charge', 'adjustment', 'migration'].includes(sp.get('kind') ?? '')
        ? sp.get('kind')!
        : undefined;

    const entries = await prisma.ledgerEntry.findMany({
        where: {
            account_id: account.id,
            ...(kind ? { kind } : {}),
            ...(from || to ? { created_at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        },
        orderBy: { created_at: 'desc' },
        take: EXPORT_CAP + 1,
    });
    if (entries.length > EXPORT_CAP) {
        return NextResponse.json(
            { error: 'too_many_rows', detail: `超过 ${EXPORT_CAP.toLocaleString()} 条,请缩小日期范围分批导出` },
            { status: 400 },
        );
    }

    const rows = entries.map((e) => [
        bjTimeStr(e.created_at),
        KIND_LABEL[e.kind] ?? e.kind,
        Number(e.amount_cny).toFixed(4),
        Number(e.balance_after).toFixed(4),
        e.note ?? '',
        e.ref ?? '',
    ]);
    const csv = toCsv(['时间(北京)', '类型', '金额(¥)', '余额快照(¥)', '备注', '关联任务ID'], rows);
    const stamp = bjTimeStr(new Date()).slice(0, 10);
    return new NextResponse(csv, {
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="seedance-billing-${stamp}.csv"`,
        },
    });
}

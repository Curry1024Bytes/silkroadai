import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireEnterpriseUser } from '@/lib/enterprise/session';
import { ENTERPRISE_TIER } from '@/lib/enterprise/billing';
import { reconcileStaleTasks } from '@/lib/enterprise/reconcile';
import { parseDay, toCsv, bjTimeStr } from '@/lib/enterprise/query';
import { officialCostCny, type Resolution } from '@/lib/seedance/cn-billing';
import { variantForModel } from '@/lib/seedance/cn-adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXPORT_CAP = 50_000; // 防爆内存;超出提示缩小日期范围

/**
 * GET /api/enterprise/export/logs?from=&to=&status= — 调用日志 CSV 导出(2026-07-26)。
 * cookie session 守门;筛选与日志页一致;列含官方价/折扣/实付(对账)与失败原因(权责)。
 */
export async function GET(req: NextRequest) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    await reconcileStaleTasks(user.id); // 导出前对账,别把滞留状态导出去

    const sp = req.nextUrl.searchParams;
    const from = parseDay(sp.get('from'));
    const to = parseDay(sp.get('to'), true);
    const status = ['queued', 'in_progress', 'completed', 'failed'].includes(sp.get('status') ?? '')
        ? sp.get('status')!
        : undefined;

    const where = {
        user_id: user.id,
        tier: ENTERPRISE_TIER,
        ...(status ? { status } : {}),
        ...(from || to ? { created_at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    };
    const tasks = await prisma.seedanceVideoTask.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: EXPORT_CAP + 1,
    });
    if (tasks.length > EXPORT_CAP) {
        return NextResponse.json(
            { error: 'too_many_rows', detail: `超过 ${EXPORT_CAP.toLocaleString()} 条,请缩小日期范围分批导出` },
            { status: 400 },
        );
    }

    const rows = tasks.map((t) => {
        const paid = t.billed && t.cost_cny != null ? Number(t.cost_cny) : null;
        const official =
            paid != null && t.tokens != null
                ? officialCostCny(t.tokens, t.resolution as Resolution, t.has_video, variantForModel(t.model))
                : null;
        const discount =
            paid != null && official != null && official > 0 ? Math.round((paid / official) * 1000) / 100 : null;
        return [
            bjTimeStr(t.created_at),
            t.id,
            t.model,
            t.resolution,
            `${t.duration}s`,
            t.status,
            t.fail_reason ?? '',
            t.tokens != null ? Number(t.tokens) : '',
            official != null ? official.toFixed(4) : '',
            discount != null ? `${discount}折` : '',
            paid != null ? paid.toFixed(4) : '',
        ];
    });
    const csv = toCsv(
        [
            '时间(北京)',
            '任务ID',
            '模型',
            '分辨率',
            '时长',
            '状态',
            '失败原因',
            'Tokens',
            '官方价(¥)',
            '折扣',
            '实付(¥)',
        ],
        rows,
    );
    const stamp = bjTimeStr(new Date()).slice(0, 10);
    return new NextResponse(csv, {
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="seedance-logs-${stamp}.csv"`,
        },
    });
}

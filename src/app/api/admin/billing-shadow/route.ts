import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { quotaToCny } from '@/lib/newapi/client';

export const runtime = 'nodejs';

/**
 * GET /api/admin/billing-shadow — P4a 影子计量对账(只读)。
 *
 * 汇总某时间窗内 portal 计量的 ¥ 成本 vs new-api 实扣 quota(换算 ¥)+ 差异;按模型/客户下钻;
 * 高亮 matched=false(我们还没配价的 model×tier)。**影子数据,未对客户生效**。
 * cookie + admin + tenantScope(UsageRecord 有 tenant_id 列)。
 */
const num = (v: unknown): number => (v == null ? 0 : Number(v));

function rangeStart(period: string, now: Date): Date | null {
    if (period === 'all') return null;
    const days = period === '30d' ? 30 : 7;
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
}

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const raw = new URL(request.url).searchParams.get('period') ?? '7d';
    const period = raw === '30d' || raw === 'all' ? raw : '7d';
    const start = rangeStart(period, new Date());
    const where = { ...tenantScope(admin), ...(start ? { log_created_at: { gte: start } } : {}) };

    // Summary split by matched (one groupBy yields counts + ¥/quota sums for both buckets).
    const byMatched = await prisma.usageRecord.groupBy({
        by: ['matched'],
        where,
        _sum: { cost_cny: true, newapi_quota: true },
        _count: { _all: true },
    });
    let records = 0;
    let matched = 0;
    let unmatched = 0;
    let costCny = 0;
    let newapiQuota = 0;
    for (const g of byMatched) {
        records += g._count._all;
        if (g.matched) matched += g._count._all;
        else unmatched += g._count._all;
        costCny += num(g._sum.cost_cny);
        newapiQuota += num(g._sum.newapi_quota);
    }
    const newapiCny = quotaToCny(newapiQuota);
    const diffCny = costCny - newapiCny;
    const diffRate = newapiCny > 0 ? diffCny / newapiCny : null;

    // By model × tier.
    const byModelG = await prisma.usageRecord.groupBy({
        by: ['model_slug', 'tier'],
        where,
        _sum: { cost_cny: true, newapi_quota: true },
        _count: { _all: true },
    });
    const byModel = byModelG
        .map((g) => ({
            model_slug: g.model_slug,
            tier: g.tier,
            records: g._count._all,
            costCny: num(g._sum.cost_cny),
            newapiQuota: num(g._sum.newapi_quota),
            newapiCny: quotaToCny(num(g._sum.newapi_quota)),
        }))
        .sort((a, b) => b.newapiQuota - a.newapiQuota);

    // By customer (join email in one findMany).
    const byUserG = await prisma.usageRecord.groupBy({
        by: ['user_id'],
        where,
        _sum: { cost_cny: true, newapi_quota: true },
        _count: { _all: true },
    });
    const users = byUserG.length
        ? await prisma.user.findMany({
              where: { id: { in: byUserG.map((g) => g.user_id) } },
              select: { id: true, email: true },
          })
        : [];
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    const byCustomer = byUserG
        .map((g) => ({
            user_id: g.user_id,
            email: emailById.get(g.user_id) ?? null,
            records: g._count._all,
            costCny: num(g._sum.cost_cny),
            newapiQuota: num(g._sum.newapi_quota),
            newapiCny: quotaToCny(num(g._sum.newapi_quota)),
        }))
        .sort((a, b) => b.newapiQuota - a.newapiQuota);

    // Unmatched (model×tier we haven't priced yet) — the actionable list for operator.
    const unmatchedG = await prisma.usageRecord.groupBy({
        by: ['model_slug', 'tier'],
        where: { ...where, matched: false },
        _count: { _all: true },
    });
    const unmatchedList = unmatchedG
        .map((g) => ({ model_slug: g.model_slug, tier: g.tier, records: g._count._all }))
        .sort((a, b) => b.records - a.records);

    return NextResponse.json({
        period,
        rangeStart: start ? start.toISOString() : null,
        summary: { records, matched, unmatched, costCny, newapiQuota, newapiCny, diffCny, diffRate },
        byModel,
        byCustomer,
        unmatched: unmatchedList,
    });
}

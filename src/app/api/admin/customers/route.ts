import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { Prisma } from '@prisma/client';
import { QUOTA_PER_USD, USD_TO_CNY_RATE } from '@/lib/newapi/quota-units';

export const runtime = 'nodejs';

/**
 * GET /api/admin/customers — P6b-2 只读客户列表(分页,tenant-scoped)。
 *
 * partner admin 也能用(gate = admin),`tenantScope(admin)` 收敛到自己租户;
 * superadmin 看全部。按注册时间或人民币余额排序，排序在分页前执行。
 */
const USAGE_WINDOW_DAYS = 30;

type RankedCustomer = {
    id: string;
    email: string;
    admin_alias: string | null;
    status: string;
    created_at: Date;
    balance_cny: Prisma.Decimal;
    balance_cached_at: Date | null;
    balance_pending: boolean;
    key_count: number;
};

const positiveInteger = (value: string | null, fallback: number, max: number) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? Math.min(number, max) : fallback;
};

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    const sp = request.nextUrl.searchParams;
    const page = positiveInteger(sp.get('page'), 1, 1_000_000);
    const pageSize = positiveInteger(sp.get('page_size'), 20, 100);
    const balanceOrder = sp.get('sort') === 'balance' ? Prisma.sql`balance_cny DESC, ` : Prisma.empty;
    const q = sp
        .get('q')
        ?.trim()
        .replace(/[\\%_]/g, '\\$&');

    // P6b §0/P1: 租户隔离 —— superadmin → {}(看全部),partner admin → 自己 tenant_id。
    const scope = tenantScope(admin);
    const where: Prisma.UserWhereInput = { ...scope };
    if (q) {
        where.OR = [
            { email: { contains: q, mode: 'insensitive' } },
            { admin_alias: { contains: q, mode: 'insensitive' } },
        ];
    }
    const tenantFilter = scope.tenant_id ? Prisma.sql`AND u.tenant_id = ${scope.tenant_id}::uuid` : Prisma.empty;
    const searchFilter = q
        ? Prisma.sql`AND (u.email ILIKE ${'%' + q + '%'} OR u.admin_alias ILIKE ${'%' + q + '%'})`
        : Prisma.empty;

    const [users, total] = await Promise.all([
        prisma.$queryRaw<RankedCustomer[]>`
            WITH ranked_page AS (
                SELECT u.id, u.email, u.admin_alias, u.status::text AS status, u.created_at,
                    CASE WHEN u.billing_mode = 'portal' THEN NULL ELSE u.newapi_cached_at END AS balance_cached_at,
                    (u.billing_mode <> 'portal' AND u.newapi_quota_cache IS NULL) AS balance_pending,
                    GREATEST(0, CASE
                        WHEN u.billing_mode = 'portal' THEN COALESCE(a.balance_cny, 0)
                        ELSE COALESCE(u.newapi_quota_cache, 0)::numeric * ${USD_TO_CNY_RATE}::numeric
                             / ${QUOTA_PER_USD}::numeric
                    END) AS balance_cny
                FROM users AS u
                LEFT JOIN accounts AS a ON a.user_id = u.id AND u.billing_mode = 'portal'
                WHERE TRUE ${tenantFilter} ${searchFilter}
                ORDER BY ${balanceOrder}u.created_at DESC, u.id DESC
                LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
            )
            SELECT p.*, (SELECT count(*)::int FROM newapi_tokens AS k WHERE k.user_id = p.id) AS key_count
            FROM ranked_page AS p
            ORDER BY ${balanceOrder}p.created_at DESC, p.id DESC
        `,
        prisma.user.count({ where }),
    ]);

    // 近 30 天用量:只聚合当前页用户(user_id IN pageIds),避免全表 groupBy。
    // 调用数 = 全部记录(matched + unmatched 都计);¥ 成本 = sum cost_cny
    // (unmatched 的 cost_cny 落库即 0,所以直接 sum 不需 matched 过滤)。
    const ids = users.map((u) => u.id);
    const usageStart = new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1_000);
    const usageByUser = ids.length
        ? await prisma.usageRecord.groupBy({
              by: ['user_id'],
              where: { user_id: { in: ids }, log_created_at: { gte: usageStart } },
              _sum: { cost_cny: true },
              _count: { _all: true },
          })
        : [];
    const usageMap = new Map(
        usageByUser.map((g) => [g.user_id, { calls: g._count._all, costCny: Number(g._sum.cost_cny ?? 0) }]),
    );

    return NextResponse.json({
        customers: users.map((u) => ({
            id: u.id,
            email: u.email,
            admin_alias: u.admin_alias,
            status: u.status,
            created_at: u.created_at,
            balance_cny: Number(u.balance_cny),
            balance_cached_at: u.balance_cached_at,
            balance_pending: u.balance_pending,
            key_count: u.key_count,
            usage_30d: usageMap.get(u.id) ?? { calls: 0, costCny: 0 },
        })),
        total,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(total / pageSize),
        usage_window_days: USAGE_WINDOW_DAYS,
    });
}

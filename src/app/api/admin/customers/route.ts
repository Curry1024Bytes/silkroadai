import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { Prisma } from '@prisma/client';
import { quotaToCny } from '@/lib/newapi/client';

export const runtime = 'nodejs';

/**
 * GET /api/admin/customers — P6b-2 只读客户列表(分页,tenant-scoped)。
 *
 * partner admin 也能用(gate = admin),`tenantScope(admin)` 收敛到自己租户;
 * superadmin 看全部。每行:邮箱 / 注册时间 / 状态 / 余额(new-api quota 缓存折 ¥)/
 * key 数 / 近 30 天用量(P4a UsageRecord:调用数 + ¥ 成本)。**纯只读,无写端点。**
 */
const USAGE_WINDOW_DAYS = 30;

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    const sp = request.nextUrl.searchParams;
    const page = Math.max(1, Number(sp.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, Number(sp.get('page_size') || '20')));
    const q = sp.get('q')?.trim();

    // P6b §0/P1: 租户隔离 —— superadmin → {}(看全部),partner admin → 自己 tenant_id。
    const where: Prisma.UserWhereInput = { ...tenantScope(admin) };
    if (q) where.email = { contains: q, mode: 'insensitive' };

    const [users, total] = await Promise.all([
        prisma.user.findMany({
            where,
            orderBy: { created_at: 'desc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
            select: {
                id: true,
                email: true,
                status: true,
                created_at: true,
                newapi_quota_cache: true,
                newapi_cached_at: true,
                _count: { select: { keys: true } },
            },
        }),
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
            status: u.status,
            created_at: u.created_at,
            // gotcha #3: 流式小额超支可能让 quota 短暂为负,余额永不显示负数。
            balance_cny: Math.max(0, quotaToCny(Number(u.newapi_quota_cache ?? 0))),
            balance_cached_at: u.newapi_cached_at,
            key_count: u._count.keys,
            usage_30d: usageMap.get(u.id) ?? { calls: 0, costCny: 0 },
        })),
        total,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(total / pageSize),
        usage_window_days: USAGE_WINDOW_DAYS,
    });
}

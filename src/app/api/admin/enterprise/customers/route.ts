import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';

export const runtime = 'nodejs';

/**
 * GET /api/admin/enterprise/customers — 企业客户列表(运营后台 /enterprise-admin 数据源)。
 * 企业客户 = 有 enterprise_upstream_keys 行的 User。带余额/累计消费/active key 数/上游备注。
 * 守门:superadmin(session 或 break-glass token)。
 */
export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const ups = await prisma.enterpriseUpstreamKey.findMany({
        select: { user_id: true, note: true, discount: true },
        orderBy: { created_at: 'asc' },
    });
    const userIds = ups.map((u) => u.user_id);

    const [users, accounts, keyCounts] = await Promise.all([
        prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, email: true, nickname: true, created_at: true },
        }),
        prisma.account.findMany({
            where: { user_id: { in: userIds } },
            select: { id: true, user_id: true, balance_cny: true },
        }),
        prisma.enterpriseKey.groupBy({
            by: ['user_id', 'status'],
            where: { user_id: { in: userIds } },
            _count: { _all: true },
        }),
    ]);
    const spent = await prisma.ledgerEntry.groupBy({
        by: ['account_id'],
        where: { account_id: { in: accounts.map((a) => a.id) }, kind: 'charge' },
        _sum: { amount_cny: true },
    });

    const userById = new Map(users.map((u) => [u.id, u]));
    const accountByUser = new Map(accounts.map((a) => [a.user_id, a]));
    const spentByAccount = new Map(spent.map((s) => [s.account_id, Math.abs(Number(s._sum.amount_cny ?? 0))]));
    const activeKeys = new Map<string, number>();
    for (const k of keyCounts) {
        if (k.status === 'active') activeKeys.set(k.user_id, k._count._all);
    }

    return NextResponse.json({
        customers: ups
            .filter((u) => userById.has(u.user_id))
            .map((u) => {
                const user = userById.get(u.user_id)!;
                const account = accountByUser.get(u.user_id);
                return {
                    user_id: u.user_id,
                    email: user.email,
                    name: user.nickname,
                    balance_cny: account ? Number(account.balance_cny) : 0,
                    spent_cny: account ? (spentByAccount.get(account.id) ?? 0) : 0,
                    active_keys: activeKeys.get(u.user_id) ?? 0,
                    upstream_note: u.note,
                    discount: Number(u.discount ?? 1),
                    created_at: user.created_at.toISOString(),
                };
            }),
    });
}

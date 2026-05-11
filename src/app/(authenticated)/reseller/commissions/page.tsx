/**
 * /reseller/commissions — commission ledger (PR-U2).
 *
 * Server component. Query: ?status=pending|confirmed|settled|all (default all) +
 * ?month=YYYY-MM (optional) + ?page=N.
 *
 * Renders aggregates + paginated row list. Mobile cards / desktop table
 * split via CommissionsClient.
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { fetchResellerStatus } from '@/lib/reseller/fetch-status';
import { prisma } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import { maskEmail } from '@/lib/reseller/mask';
import { CommissionsClient, type CommissionRow, type StatusFilter } from './commissions-client';

export const dynamic = 'force-dynamic';
export const metadata = { title: '佣金明细 — 代理后台' };

const PAGE_SIZE = 50;
const MONTH_RX = /^\d{4}-(0[1-9]|1[0-2])$/;

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/reseller/commissions', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

function parseStatus(raw: string | string[] | undefined): StatusFilter {
    if (raw === 'pending' || raw === 'confirmed' || raw === 'settled') return raw;
    return 'all';
}

function parseMonth(raw: string | string[] | undefined): string | null {
    if (!raw || Array.isArray(raw)) return null;
    return MONTH_RX.test(raw) ? raw : null;
}

function parsePage(raw: string | string[] | undefined): number {
    if (!raw || Array.isArray(raw)) return 1;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 ? n : 1;
}

function monthBounds(month: string): { start: Date; end: Date } {
    const [yStr, mStr] = month.split('-');
    const y = Number(yStr);
    const m = Number(mStr);
    return {
        start: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0)),
        end: new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)),
    };
}

export default async function ResellerCommissionsPage({
    searchParams,
}: {
    searchParams: Promise<{ status?: string; month?: string; page?: string }>;
}) {
    const user = await getSessionUser();
    if (!user) return null;
    const status = await fetchResellerStatus(user.id);
    if (!status.isReseller) redirect('/reseller');

    const reseller = await prisma.reseller.findUnique({
        where: { user_id: user.id },
        select: { id: true },
    });
    if (!reseller) redirect('/reseller');

    const sp = await searchParams;
    const statusFilter = parseStatus(sp.status);
    const monthFilter = parseMonth(sp.month);
    const page = parsePage(sp.page);
    const skip = (page - 1) * PAGE_SIZE;

    const where: Prisma.ResellerCommissionWhereInput = { reseller_id: reseller.id };
    if (statusFilter !== 'all') where.status = statusFilter;
    if (monthFilter) {
        const { start, end } = monthBounds(monthFilter);
        where.created_at = { gte: start, lt: end };
    }

    // For the "across all statuses" summary, drop the status filter (but
    // keep month if set) — gives the totals row a useful baseline.
    const summaryWhere: Prisma.ResellerCommissionWhereInput = { reseller_id: reseller.id };
    if (monthFilter) summaryWhere.created_at = where.created_at;

    const [rows, total, summary, gmvSum] = await Promise.all([
        prisma.resellerCommission.findMany({
            where,
            orderBy: { created_at: 'desc' },
            skip,
            take: PAGE_SIZE,
            include: { user: { select: { email: true } } },
        }),
        prisma.resellerCommission.count({ where }),
        prisma.resellerCommission.groupBy({
            by: ['status'],
            where: summaryWhere,
            _sum: { commission_amount: true },
            _count: { _all: true },
        }),
        prisma.resellerCommission.aggregate({
            where: summaryWhere,
            _sum: { attributed_gmv: true },
        }),
    ]);

    let sumPending = 0;
    let sumConfirmed = 0;
    let sumSettled = 0;
    let countPending = 0;
    let countConfirmed = 0;
    let countSettled = 0;
    for (const g of summary) {
        const amount = g._sum.commission_amount ? Number(g._sum.commission_amount) : 0;
        if (g.status === 'pending') {
            sumPending = amount;
            countPending = g._count._all;
        }
        if (g.status === 'confirmed') {
            sumConfirmed = amount;
            countConfirmed = g._count._all;
        }
        if (g.status === 'settled') {
            sumSettled = amount;
            countSettled = g._count._all;
        }
    }

    const initialRows: CommissionRow[] = rows.map((r) => ({
        id: r.id,
        customer_email_masked: maskEmail(r.user?.email),
        attributed_gmv_cny: Number(r.attributed_gmv),
        commission_rate: Number(r.commission_rate),
        commission_amount_cny: Number(r.commission_amount),
        status: r.status,
        admin_review_required: r.admin_review_required,
        hold_until: r.hold_until.toISOString(),
        settled_at: r.settled_at ? r.settled_at.toISOString() : null,
        created_at: r.created_at.toISOString(),
    }));

    return (
        <CommissionsClient
            rows={initialRows}
            summary={{
                gmv_cny: gmvSum._sum.attributed_gmv ? Number(gmvSum._sum.attributed_gmv) : 0,
                pending_cny: sumPending,
                confirmed_cny: sumConfirmed,
                settled_cny: sumSettled,
                count_pending: countPending,
                count_confirmed: countConfirmed,
                count_settled: countSettled,
            }}
            filters={{ status: statusFilter, month: monthFilter }}
            pagination={{ page, limit: PAGE_SIZE, total, hasMore: skip + rows.length < total }}
        />
    );
}

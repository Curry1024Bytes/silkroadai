/**
 * /reseller/settlement — settlement requests + history (PR-U2).
 *
 * Two sections:
 *   1. "可申请结算" card — aggregates confirmed commissions for the
 *      previous UTC month + this UTC month. Surfaces a CTA per month
 *      that's >= ¥100 confirmed; greyed out otherwise.
 *   2. History list of past ResellerSettlement rows (paid / requested /
 *      pending), sorted by period_month desc.
 *
 * Settle info gate: if reseller.settle_method/account/name is empty,
 * show a yellow banner at the top with the link to fill it in (Phase 2
 * gets the actual settle-info edit form; for now operator can update via
 * a future endpoint or DB).
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { fetchResellerStatus } from '@/lib/reseller/fetch-status';
import { prisma } from '@/lib/db';
import { SettlementClient, type SettlementHistoryRow } from './settlement-client';

export const dynamic = 'force-dynamic';
export const metadata = { title: '结算 — 代理后台' };

/** Settlement min-threshold mirror of brief: "单次满 ¥100 起结". */
export const SETTLEMENT_MIN_CNY = 100;

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/reseller/settlement', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

function utcPeriodMonth(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

function previousUtcPeriodMonth(now: Date = new Date()): string {
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return utcPeriodMonth(prev);
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

async function aggregateMonth(reseller_id: string, month: string) {
    const { start, end } = monthBounds(month);
    const [confirmed, pendingCount] = await Promise.all([
        prisma.resellerCommission.aggregate({
            where: {
                reseller_id,
                created_at: { gte: start, lt: end },
                status: { in: ['confirmed', 'settled'] },
            },
            _sum: { commission_amount: true },
            _count: { _all: true },
        }),
        prisma.resellerCommission.count({
            where: { reseller_id, created_at: { gte: start, lt: end }, status: 'pending' },
        }),
    ]);
    return {
        period: month,
        confirmed_cny: confirmed._sum.commission_amount ? Number(confirmed._sum.commission_amount) : 0,
        confirmed_count: confirmed._count._all,
        pending_count: pendingCount,
    };
}

export default async function ResellerSettlementPage() {
    const user = await getSessionUser();
    if (!user) return null;
    const status = await fetchResellerStatus(user.id);
    if (!status.isReseller) redirect('/reseller');

    const reseller = await prisma.reseller.findUnique({ where: { user_id: user.id } });
    if (!reseller) redirect('/reseller');

    const now = new Date();
    const thisMonth = utcPeriodMonth(now);
    const prevMonth = previousUtcPeriodMonth(now);

    const [thisMonthAgg, prevMonthAgg, history] = await Promise.all([
        aggregateMonth(reseller.id, thisMonth),
        aggregateMonth(reseller.id, prevMonth),
        prisma.resellerSettlement.findMany({
            where: { reseller_id: reseller.id },
            orderBy: { period_month: 'desc' },
            take: 24, // 2 years of months
        }),
    ]);

    const settleInfoComplete = !!reseller.settle_method && !!reseller.settle_account && !!reseller.settle_name;

    const historyRows: SettlementHistoryRow[] = history.map((s) => ({
        id: s.id,
        period_month: s.period_month,
        total_commission_cny: Number(s.total_commission),
        commission_count: s.commission_count,
        status: s.status,
        requested_at: s.requested_at ? s.requested_at.toISOString() : null,
        paid_at: s.paid_at ? s.paid_at.toISOString() : null,
        paid_tx_ref: s.paid_tx_ref,
        notes: s.notes,
    }));

    return (
        <SettlementClient
            settleInfoComplete={settleInfoComplete}
            settleMethod={reseller.settle_method}
            settleAccount={reseller.settle_account}
            settleName={reseller.settle_name}
            thisMonth={thisMonthAgg}
            prevMonth={prevMonthAgg}
            history={historyRows}
            minThresholdCny={SETTLEMENT_MIN_CNY}
        />
    );
}

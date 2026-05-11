/**
 * GET /api/portal/reseller/dashboard (PR-U1)
 *
 * Aggregated dashboard payload for the current user's reseller.
 *
 * Response:
 *   {
 *     current_tier: 'bronze' | 'silver' | 'gold',
 *     cumulative_gmv_cny: number,
 *     tier_progress: { next: 'silver' | 'gold' | null, gmv_needed_to_next_cny: number | null },
 *     this_month: { gmv_cny, pending_commission_cny, confirmed_commission_cny },
 *     total_customers: number,
 *     active_codes: number,
 *     last_settlement: { period_month, status, total_commission_cny, paid_at } | null
 *   }
 *
 * No mutations. Built off 5 parallel queries + tier-progress helper.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthedReseller } from '@/lib/reseller/auth-helper';
import { tierProgress } from '@/lib/reseller/tier';

export const runtime = 'nodejs';

function currentMonthBounds(now: Date = new Date()): { start: Date; end: Date } {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    return {
        start: new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)),
        end: new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0)),
    };
}

export async function GET(req: NextRequest) {
    const auth = await getAuthedReseller(req);
    if (!auth.ok) return auth.response;
    const { reseller } = auth.ctx;
    const { start, end } = currentMonthBounds();

    const [thisMonthAgg, customersCount, activeCodesCount, lastSettlement] = await Promise.all([
        prisma.resellerCommission.groupBy({
            by: ['status'],
            where: {
                reseller_id: reseller.id,
                created_at: { gte: start, lt: end },
            },
            _sum: { attributed_gmv: true, commission_amount: true },
        }),
        prisma.user.count({ where: { inviter_reseller_id: reseller.id } }),
        prisma.resellerInviteCode.count({
            where: { reseller_id: reseller.id, is_active: true },
        }),
        prisma.resellerSettlement.findFirst({
            where: { reseller_id: reseller.id },
            orderBy: { period_month: 'desc' },
            select: {
                period_month: true,
                status: true,
                total_commission: true,
                paid_at: true,
            },
        }),
    ]);

    let monthGmv = 0;
    let monthPending = 0;
    let monthConfirmed = 0;
    for (const g of thisMonthAgg) {
        const gmv = g._sum.attributed_gmv ? Number(g._sum.attributed_gmv) : 0;
        const commission = g._sum.commission_amount ? Number(g._sum.commission_amount) : 0;
        monthGmv += gmv;
        if (g.status === 'pending') monthPending += commission;
        if (g.status === 'confirmed') monthConfirmed += commission;
    }

    const progress = tierProgress(reseller.cumulative_gmv);

    return NextResponse.json({
        current_tier: reseller.tier,
        cumulative_gmv_cny: Number(reseller.cumulative_gmv),
        tier_progress: progress
            ? {
                  next: progress.next.tier,
                  gmv_needed_to_next_cny: progress.gmvNeededToNextCny,
              }
            : { next: null, gmv_needed_to_next_cny: null },
        this_month: {
            gmv_cny: monthGmv,
            pending_commission_cny: monthPending,
            confirmed_commission_cny: monthConfirmed,
        },
        total_customers: customersCount,
        active_codes: activeCodesCount,
        last_settlement: lastSettlement
            ? {
                  period_month: lastSettlement.period_month,
                  status: lastSettlement.status,
                  total_commission_cny: Number(lastSettlement.total_commission),
                  paid_at: lastSettlement.paid_at ? lastSettlement.paid_at.toISOString() : null,
              }
            : null,
    });
}

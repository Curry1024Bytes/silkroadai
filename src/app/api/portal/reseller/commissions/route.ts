/**
 * GET /api/portal/reseller/commissions (PR-U1)
 *
 * Commission flow listing + per-month aggregates for the current user's
 * reseller.
 *
 * Query params:
 *   - month  (YYYY-MM, optional) — UTC month filter. If omitted, no filter.
 *   - status (pending|confirmed|settled|all, default "all")
 *   - page   (number, default 1)
 *   - limit  (number, default 50, max 200)
 *
 * Response:
 *   {
 *     summary: {
 *       gmv_cny: total attributed GMV for the filter
 *       pending_cny / confirmed_cny / settled_cny: by-status sum of commission_amount
 *       count_total / count_pending / count_confirmed / count_settled
 *     },
 *     rows: [{
 *       id, customer_email_masked, attributed_gmv_cny, commission_rate,
 *       commission_amount_cny, status, admin_review_required,
 *       hold_until, settled_at, created_at
 *     }, ...],
 *     pagination: { page, limit, total, has_more }
 *   }
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import { getAuthedReseller } from '@/lib/reseller/auth-helper';
import { maskEmail } from '@/lib/reseller/mask';

export const runtime = 'nodejs';

const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

const QuerySchema = z.object({
    month: z.string().regex(MONTH_REGEX).optional(),
    status: z.enum(['pending', 'confirmed', 'settled', 'all']).default('all'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Convert "2026-06" → [start, end) for UTC month. */
function monthBounds(month: string): { start: Date; end: Date } {
    const [yStr, mStr] = month.split('-');
    const y = Number(yStr);
    const m = Number(mStr); // 1-12
    return {
        start: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0)),
        end: new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)),
    };
}

export async function GET(req: NextRequest) {
    const auth = await getAuthedReseller(req);
    if (!auth.ok) return auth.response;
    const { ctx } = auth;

    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_query', details: parsed.error.flatten() }, { status: 400 });
    }
    const { month, status, page, limit } = parsed.data;

    const where: Prisma.ResellerCommissionWhereInput = {
        reseller_id: ctx.reseller.id,
    };
    if (status !== 'all') where.status = status;
    if (month) {
        const { start, end } = monthBounds(month);
        where.created_at = { gte: start, lt: end };
    }

    const skip = (page - 1) * limit;

    // Run aggregation + page query in parallel.
    const [rows, total, statusGroups, gmvSum] = await Promise.all([
        prisma.resellerCommission.findMany({
            where,
            orderBy: { created_at: 'desc' },
            skip,
            take: limit,
            include: {
                user: { select: { email: true } },
            },
        }),
        prisma.resellerCommission.count({ where }),
        prisma.resellerCommission.groupBy({
            by: ['status'],
            where: { reseller_id: ctx.reseller.id, ...(month ? { created_at: where.created_at } : {}) },
            _sum: { commission_amount: true },
            _count: { _all: true },
        }),
        prisma.resellerCommission.aggregate({
            where: { reseller_id: ctx.reseller.id, ...(month ? { created_at: where.created_at } : {}) },
            _sum: { attributed_gmv: true },
        }),
    ]);

    const sumByStatus = new Map<string, { sum: number; count: number }>();
    for (const g of statusGroups) {
        sumByStatus.set(g.status, {
            sum: g._sum.commission_amount ? Number(g._sum.commission_amount) : 0,
            count: g._count._all,
        });
    }
    const summary = {
        gmv_cny: gmvSum._sum.attributed_gmv ? Number(gmvSum._sum.attributed_gmv) : 0,
        pending_cny: sumByStatus.get('pending')?.sum ?? 0,
        confirmed_cny: sumByStatus.get('confirmed')?.sum ?? 0,
        settled_cny: sumByStatus.get('settled')?.sum ?? 0,
        count_total:
            (sumByStatus.get('pending')?.count ?? 0) +
            (sumByStatus.get('confirmed')?.count ?? 0) +
            (sumByStatus.get('settled')?.count ?? 0),
        count_pending: sumByStatus.get('pending')?.count ?? 0,
        count_confirmed: sumByStatus.get('confirmed')?.count ?? 0,
        count_settled: sumByStatus.get('settled')?.count ?? 0,
    };

    return NextResponse.json({
        summary,
        rows: rows.map((r) => ({
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
        })),
        pagination: {
            page,
            limit,
            total,
            has_more: skip + rows.length < total,
        },
    });
}

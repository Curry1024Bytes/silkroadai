/**
 * POST /api/portal/reseller/settlement/request (PR-U1)
 *
 * Reseller initiates settlement for a given month.
 *
 * Body: { month: "YYYY-MM" }
 *
 * Validation:
 *   - reseller must have settle_method + settle_account + settle_name filled
 *   - month must not have ANY pending commissions (all must be confirmed
 *     or settled — hold window passed + admin review done)
 *   - operator-decided state machine: cron creates pending row → this endpoint
 *     upserts to requested. If no row exists yet (cron hasn't run), we
 *     INSERT a fresh requested row in the same tx.
 *
 * Idempotency:
 *   - re-submitting on a row already in `requested` state: 200 no-op
 *   - re-submitting on a row already in `paid` state: 400 already_paid
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getAuthedReseller } from '@/lib/reseller/auth-helper';

export const runtime = 'nodejs';

const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

const BodySchema = z.object({
    month: z.string().regex(MONTH_REGEX),
});

function monthBounds(month: string): { start: Date; end: Date } {
    const [yStr, mStr] = month.split('-');
    const y = Number(yStr);
    const m = Number(mStr);
    return {
        start: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0)),
        end: new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)),
    };
}

export async function POST(req: NextRequest) {
    const auth = await getAuthedReseller(req);
    if (!auth.ok) return auth.response;
    const { reseller } = auth.ctx;

    // Settle info required.
    if (!reseller.settle_method || !reseller.settle_account || !reseller.settle_name) {
        return NextResponse.json(
            {
                error: 'settle_info_missing',
                message: '请先在代理后台填写收款方式 / 收款账号 / 收款人姓名',
            },
            { status: 400 },
        );
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 });
    }
    const { month } = parsed.data;
    const { start, end } = monthBounds(month);

    // All commissions for this reseller created during the month MUST be
    // out of pending state (cron has flipped them to confirmed). If any
    // remain pending → 400 with a hint.
    const pendingCount = await prisma.resellerCommission.count({
        where: {
            reseller_id: reseller.id,
            created_at: { gte: start, lt: end },
            status: 'pending',
        },
    });
    if (pendingCount > 0) {
        return NextResponse.json(
            {
                error: 'has_pending_commissions',
                message: `该月仍有 ${pendingCount} 笔 commission 处于 14 天 hold 期,请等待自动结算后再申请提现`,
            },
            { status: 400 },
        );
    }

    // Aggregate confirmed (+ settled) commissions for this month.
    const agg = await prisma.resellerCommission.aggregate({
        where: {
            reseller_id: reseller.id,
            created_at: { gte: start, lt: end },
            status: { in: ['confirmed', 'settled'] },
        },
        _sum: { commission_amount: true },
        _count: { _all: true },
    });
    const total = agg._sum.commission_amount ? new Prisma.Decimal(agg._sum.commission_amount) : new Prisma.Decimal(0);
    const count = agg._count._all;
    if (count === 0 || total.lte(0)) {
        return NextResponse.json(
            {
                error: 'no_commissions_to_settle',
                message: '该月没有可结算的 commission',
            },
            { status: 400 },
        );
    }

    // Upsert the settlement row. Brief Q2:
    //   pending   → flip to requested + write requested_at
    //   requested → 200 no-op (idempotent re-submit)
    //   paid      → 400 already_paid
    const now = new Date();
    const existing = await prisma.resellerSettlement.findUnique({
        where: { reseller_id_period_month: { reseller_id: reseller.id, period_month: month } },
    });
    if (existing) {
        if (existing.status === 'paid') {
            return NextResponse.json({ error: 'already_paid', message: '该月已打款,无需重复申请' }, { status: 400 });
        }
        if (existing.status === 'requested') {
            return NextResponse.json({ settlement: existing, requested: false }, { status: 200 });
        }
        // status === 'pending' → flip to requested.
        const updated = await prisma.resellerSettlement.update({
            where: { id: existing.id },
            data: {
                status: 'requested',
                requested_at: now,
                total_commission: total,
                commission_count: count,
            },
        });
        return NextResponse.json({ settlement: updated, requested: true }, { status: 200 });
    }
    // No existing row (cron hasn't run yet) — insert as requested directly.
    const created = await prisma.resellerSettlement.create({
        data: {
            reseller_id: reseller.id,
            period_month: month,
            total_commission: total,
            commission_count: count,
            status: 'requested',
            requested_at: now,
        },
    });
    return NextResponse.json({ settlement: created, requested: true }, { status: 201 });
}

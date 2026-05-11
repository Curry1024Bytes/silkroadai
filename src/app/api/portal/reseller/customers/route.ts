/**
 * GET /api/portal/reseller/customers (PR-U1)
 *
 * Paginated list of customers attributed to the current user's reseller.
 * Privacy: email masked + sequential #001/#002 customer label per
 * reseller (invitation order, NOT user_id hash). No raw user_id or sk-*
 * exposed.
 *
 * Query params:
 *   - page (number, default 1, 1-based)
 *   - limit (number, default 20, max 100)
 *
 * Per-customer fields surfaced:
 *   - seq_no            "#001" etc (computed from invitation order)
 *   - email_masked      "abc***@gmail.com"
 *   - joined_at         registration timestamp ISO
 *   - attribution_expires_at  ISO (when 24mo protection ends)
 *   - attribution_active      bool — currently within protection window
 *   - total_recharged_cny     sum of attributed_gmv across all their commissions
 *   - last_recharge_at        latest commission created_at (or null)
 *   - status                  User.status (active / disabled / banned)
 *   - inviter_code            the code they used (string, e.g. "FRANK-WX-2026")
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getAuthedReseller } from '@/lib/reseller/auth-helper';
import { maskEmail, customerSeqNo } from '@/lib/reseller/mask';

export const runtime = 'nodejs';

const QuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function GET(req: NextRequest) {
    const auth = await getAuthedReseller(req);
    if (!auth.ok) return auth.response;
    const { ctx } = auth;

    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_query', details: parsed.error.flatten() }, { status: 400 });
    }
    const { page, limit } = parsed.data;
    const skip = (page - 1) * limit;
    const now = new Date();

    const [customers, total] = await Promise.all([
        prisma.user.findMany({
            where: { inviter_reseller_id: ctx.reseller.id },
            orderBy: { created_at: 'asc' }, // invitation order — seq_no derived from index in this list
            skip,
            take: limit,
            select: {
                id: true,
                email: true,
                status: true,
                created_at: true,
                attribution_expires_at: true,
                inviter_code_id: true,
            },
        }),
        prisma.user.count({ where: { inviter_reseller_id: ctx.reseller.id } }),
    ]);

    const customerIds = customers.map((c) => c.id);

    // Per-customer aggregate: sum attributed_gmv + max created_at across
    // commissions. One groupBy round-trip.
    const aggregates =
        customerIds.length === 0
            ? []
            : await prisma.resellerCommission.groupBy({
                  by: ['user_id'],
                  where: { reseller_id: ctx.reseller.id, user_id: { in: customerIds } },
                  _sum: { attributed_gmv: true },
                  _max: { created_at: true },
              });
    const aggByUser = new Map<string, { total: number; last: Date | null }>();
    for (const row of aggregates) {
        if (!row.user_id) continue;
        aggByUser.set(row.user_id, {
            total: row._sum.attributed_gmv ? Number(row._sum.attributed_gmv) : 0,
            last: row._max.created_at ?? null,
        });
    }

    // Look up inviter_code strings (FK is raw column, no relation on User).
    const codeIds = customers.map((c) => c.inviter_code_id).filter((v): v is string => !!v);
    const codes =
        codeIds.length === 0
            ? []
            : await prisma.resellerInviteCode.findMany({
                  where: { id: { in: codeIds } },
                  select: { id: true, code: true },
              });
    const codeById = new Map<string, string>();
    for (const c of codes) codeById.set(c.id, c.code);

    return NextResponse.json({
        customers: customers.map((c, idx) => {
            const agg = aggByUser.get(c.id);
            const expiry = c.attribution_expires_at;
            return {
                seq_no: customerSeqNo(skip + idx),
                email_masked: maskEmail(c.email),
                joined_at: c.created_at.toISOString(),
                attribution_expires_at: expiry ? expiry.toISOString() : null,
                attribution_active: !!expiry && expiry.getTime() > now.getTime(),
                total_recharged_cny: agg?.total ?? 0,
                last_recharge_at: agg?.last ? agg.last.toISOString() : null,
                status: c.status,
                inviter_code: c.inviter_code_id ? (codeById.get(c.inviter_code_id) ?? null) : null,
            };
        }),
        pagination: {
            page,
            limit,
            total,
            has_more: skip + customers.length < total,
        },
    });
}

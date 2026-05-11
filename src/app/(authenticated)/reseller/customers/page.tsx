/**
 * /reseller/customers — attributed customer list (PR-U2).
 *
 * Server component. Paginated via ?page=N query string. Each customer
 * surfaced as { seq_no, masked_email, joined_at, attribution_active,
 * total_recharged, last_recharge_at, status, inviter_code }. Same shape
 * as GET /api/portal/reseller/customers but inlined.
 *
 * Mobile <768px: list collapses to card view (CustomersClient handles
 * the responsive split).
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { fetchResellerStatus } from '@/lib/reseller/fetch-status';
import { prisma } from '@/lib/db';
import { maskEmail, customerSeqNo } from '@/lib/reseller/mask';
import { CustomersClient, type CustomerRow } from './customers-client';

export const dynamic = 'force-dynamic';
export const metadata = { title: '客户列表 — 代理后台' };

const PAGE_SIZE = 20;

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/reseller/customers', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

function parsePage(raw: string | string[] | undefined): number {
    if (!raw || Array.isArray(raw)) return 1;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) return 1;
    return n;
}

export default async function ResellerCustomersPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
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
    const page = parsePage(sp.page);
    const skip = (page - 1) * PAGE_SIZE;
    const now = new Date();

    const [customers, total] = await Promise.all([
        prisma.user.findMany({
            where: { inviter_reseller_id: reseller.id },
            orderBy: { created_at: 'asc' },
            skip,
            take: PAGE_SIZE,
            select: {
                id: true,
                email: true,
                status: true,
                created_at: true,
                attribution_expires_at: true,
                inviter_code_id: true,
            },
        }),
        prisma.user.count({ where: { inviter_reseller_id: reseller.id } }),
    ]);

    // Per-customer GMV + last-recharge aggregates.
    const customerIds = customers.map((c) => c.id);
    const aggregates =
        customerIds.length === 0
            ? []
            : await prisma.resellerCommission.groupBy({
                  by: ['user_id'],
                  where: { reseller_id: reseller.id, user_id: { in: customerIds } },
                  _sum: { attributed_gmv: true },
                  _max: { created_at: true },
              });
    const aggByUser = new Map<string, { total: number; last: Date | null }>();
    for (const a of aggregates) {
        if (!a.user_id) continue;
        aggByUser.set(a.user_id, {
            total: a._sum.attributed_gmv ? Number(a._sum.attributed_gmv) : 0,
            last: a._max.created_at ?? null,
        });
    }

    // Code lookup so the row can show which code each customer used.
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

    const rows: CustomerRow[] = customers.map((c, idx) => {
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
    });

    return (
        <CustomersClient
            rows={rows}
            pagination={{
                page,
                limit: PAGE_SIZE,
                total,
                hasMore: skip + rows.length < total,
            }}
        />
    );
}

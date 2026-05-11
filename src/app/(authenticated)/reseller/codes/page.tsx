/**
 * /reseller/codes — invite code management (PR-U2).
 *
 * Server component fetches the user's codes + per-code attribution
 * count + GMV, then hands off to CodesClient for the create / delete /
 * copy interactivity.
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { fetchResellerStatus } from '@/lib/reseller/fetch-status';
import { prisma } from '@/lib/db';
import { CodesClient, type CodeRow } from './codes-client';

export const dynamic = 'force-dynamic';
export const metadata = { title: '邀请码 — 代理后台' };

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/reseller/codes', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

export default async function ResellerCodesPage() {
    const user = await getSessionUser();
    if (!user) return null;
    const status = await fetchResellerStatus(user.id);
    if (!status.isReseller) redirect('/reseller');

    const reseller = await prisma.reseller.findUnique({
        where: { user_id: user.id },
        select: { id: true },
    });
    if (!reseller) redirect('/reseller');

    const codes = await prisma.resellerInviteCode.findMany({
        where: { reseller_id: reseller.id },
        orderBy: { created_at: 'asc' },
    });

    // Per-code attribution count + sum of GMV from the customers that used it.
    // Two parallel groupBys mirror the GET /codes endpoint logic.
    const [countsByCode, gmvSource] = await Promise.all([
        prisma.user.groupBy({
            by: ['inviter_code_id'],
            where: { inviter_code_id: { in: codes.map((c) => c.id) } },
            _count: { _all: true },
        }),
        prisma.user.findMany({
            where: { inviter_code_id: { in: codes.map((c) => c.id) } },
            select: {
                inviter_code_id: true,
                reseller_commissions_as_customer: { select: { attributed_gmv: true } },
            },
        }),
    ]);

    const countMap = new Map<string, number>();
    for (const c of countsByCode) if (c.inviter_code_id) countMap.set(c.inviter_code_id, c._count._all);

    const gmvMap = new Map<string, number>();
    for (const u of gmvSource) {
        if (!u.inviter_code_id) continue;
        const sum = u.reseller_commissions_as_customer.reduce((acc, c) => acc + Number(c.attributed_gmv), 0);
        gmvMap.set(u.inviter_code_id, (gmvMap.get(u.inviter_code_id) ?? 0) + sum);
    }

    const initialRows: CodeRow[] = codes.map((c) => ({
        id: c.id,
        code: c.code,
        label: c.label,
        is_active: c.is_active,
        attributed_user_count: countMap.get(c.id) ?? 0,
        total_attributed_gmv_cny: gmvMap.get(c.id) ?? 0,
        created_at: c.created_at.toISOString(),
    }));

    return <CodesClient initialRows={initialRows} />;
}

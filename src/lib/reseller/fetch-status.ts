/**
 * Server-side reseller status lookup for layout / sidebar visibility (PR-U2).
 *
 * Layout fetches this once per request; passes the (cached) boolean into
 * the Sidebar so the "代理后台" entry only shows for active resellers.
 *
 * Wrapped in React.cache() so a server component nested inside the layout
 * (e.g. /reseller/dashboard/page.tsx) can re-call this in its own flow
 * for additional data without paying a second DB round-trip.
 *
 * Brief calibration: 仅 active 显示。suspended / banned 拒掉 (returns false).
 */
import 'server-only';
import { cache } from 'react';
import { prisma } from '@/lib/db';

export interface ResellerStatusSnap {
    isReseller: boolean;
    tier?: 'bronze' | 'silver' | 'gold';
}

/** Returns `{ isReseller: false }` if user.id is null or no Reseller row,
 *  or status is suspended/banned. Otherwise `{ isReseller: true, tier }`. */
export const fetchResellerStatus = cache(async (userId: string | null): Promise<ResellerStatusSnap> => {
    if (!userId) return { isReseller: false };
    const r = await prisma.reseller.findUnique({
        where: { user_id: userId },
        select: { status: true, tier: true },
    });
    if (!r || r.status !== 'active') return { isReseller: false };
    return { isReseller: true, tier: r.tier };
});

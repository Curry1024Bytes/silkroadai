/**
 * Server-side reseller status lookup for layout / sidebar visibility +
 * promo-card gating (PR-U2 + fix/reseller-entry-discovery).
 *
 * Layout fetches this once per request; passes the snapshot into the
 * Sidebar (always-visible polymorphic entry) + /dashboard (promo card
 * gate).
 *
 * Wrapped in React.cache() so a server component nested inside the layout
 * (e.g. /reseller/dashboard/page.tsx) can re-call this in its own flow
 * for additional data without paying a second DB round-trip.
 *
 * The original `isReseller: boolean` shape is kept as a derived property
 * (status === 'active'), so PR-U2 call sites that destructure it keep
 * working. New call sites that need to differentiate active vs
 * suspended/banned vs not-yet-joined read `status` directly.
 */
import 'server-only';
import { cache } from 'react';
import { prisma } from '@/lib/db';

/** null = user has no Reseller row yet (never joined).
 *  'active' / 'suspended' / 'banned' = matches Prisma's ResellerStatus enum. */
export type ResellerStatusValue = 'active' | 'suspended' | 'banned' | null;

export interface ResellerStatusSnap {
    /** Raw status from the Reseller row, or null if no row. */
    status: ResellerStatusValue;
    /** Convenience: status === 'active'. PR-U2 call sites use this. */
    isReseller: boolean;
    /** Tier (only meaningful when status === 'active'). */
    tier?: 'bronze' | 'silver' | 'gold';
}

/** Returns `{ status: null, isReseller: false }` for non-resellers and
 *  `{ status: 'active', isReseller: true, tier }` for active resellers.
 *  Suspended/banned resellers get `{ status: 'suspended'|'banned',
 *  isReseller: false }` — they're not gated as "real" resellers for
 *  sidebar-CTA purposes, but the Sidebar shows a greyed 代理后台 entry
 *  and /reseller renders a status page instead of the join form. */
export const fetchResellerStatus = cache(async (userId: string | null): Promise<ResellerStatusSnap> => {
    if (!userId) return { status: null, isReseller: false };
    const r = await prisma.reseller.findUnique({
        where: { user_id: userId },
        select: { status: true, tier: true },
    });
    if (!r) return { status: null, isReseller: false };
    return {
        status: r.status,
        isReseller: r.status === 'active',
        tier: r.tier,
    };
});

/**
 * Authenticated route group layout.
 *
 * Single auth gate for /dashboard, /keys, /balance, /usage. Server-side
 * checks the silkroad_session cookie via getCurrentUser; redirects to
 * /login?next=<original> on null. We deliberately do NOT push this into
 * `src/middleware.ts` — Next's middleware runs on the Edge and `prisma` is
 * Node-only. Layout-level guard is good enough; if we later need pre-render
 * blocking we can revisit (W6).
 *
 * Placement note: the route group `(authenticated)` is path-invisible — the
 * URL stays `/dashboard` not `/(authenticated)/dashboard`. We picked this
 * over a `/portal/*` prefix so a future portal.silkroadai.io subdomain split
 * doesn't require URL rewrites.
 *
 * W7 P2 visual rebrand
 * --------------------
 * Header switched from filled-navy bar (#0a1535) to a paper-aligned
 * surface with a brand-border separator + primary-flat logo, matching the
 * landing page chrome. Mobile (<768px): sidebar collapses below the
 * header into a horizontal nav strip via the `Sidebar` component itself.
 */
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import type { CSSProperties } from 'react';
import { getCurrentUser } from '@/lib/auth/session';
import { fetchResellerStatus } from '@/lib/reseller/fetch-status';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { getCurrentTenant } from '@/lib/tenant/resolve';
import { Sidebar } from './sidebar';
import { LogoutButton } from './logout-button';
import { UnverifiedBanner } from './unverified-banner';
import { AnnouncementBanner } from './announcement-banner';
import { getActiveAnnouncements } from '@/lib/announcements/fetch-active';

export const dynamic = 'force-dynamic';

/** Bridge `headers()` → `NextRequest` so we can reuse `getCurrentUser`. Same
 *  pattern used in /login/page.tsx and /pay/page.tsx. */
async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/authenticated', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

/** Reconstruct the path the user was trying to reach so /login can bounce
 *  them back. `headers()` exposes x-invoke-path during dynamic rendering;
 *  fall back to /dashboard (the canonical landing) when absent. */
async function getRequestedPath(): Promise<string> {
    const h = await headers();
    const path = h.get('x-invoke-path') || h.get('x-matched-path') || h.get('next-url') || '';
    if (path && path.startsWith('/') && !path.startsWith('//')) return path;
    return '/dashboard';
}

export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
    const user = await getSessionUser();
    if (!user) {
        const next = await getRequestedPath();
        redirect(`/login?next=${encodeURIComponent(next)}`);
    }

    const showUnverifiedBanner = !user.email_verified;
    // PR-U2 + fix/reseller-entry-discovery: lookup reseller status to drive
    // the Sidebar's always-visible polymorphic reseller entry (邀请赚佣金
    // vs 代理后台 vs greyed 代理后台). Cached via React.cache() in the
    // helper so nested server components on /reseller/* don't pay a second
    // DB round-trip.
    const { status: resellerStatus } = await fetchResellerStatus(user.id);

    // P6a: tenant brand. Platform tenant's primary_color = #1a2540 (current navy) → no-op;
    // a partner domain overrides --color-navy for this dashboard subtree.
    const tenant = await getCurrentTenant();
    const brandStyle = tenant.primary_color ? ({ ['--color-navy']: tenant.primary_color } as CSSProperties) : undefined;

    // 运营公告(顶部通栏)— 全局(tenant_id=null)+ 该客户所属租户;client island 按
    // localStorage 关闭。查询抽到 helper 便于 layout 单测 mock(不连 prisma)。
    const announcements = await getActiveAnnouncements(user.tenant_id ?? null);

    return (
        <div className="min-h-screen flex flex-col bg-paper text-ink" style={brandStyle}>
            <header className="bg-paper border-b border-brand-border sticky top-0 z-40">
                <div className="flex items-center justify-between gap-4 px-6 py-3.5">
                    <div className="flex items-center gap-3">
                        <BrandLogo variant="primary-flat" size={28} />
                        <p className="hidden md:block m-0 text-xs text-minor-ink">Connecting Global Intelligence.</p>
                    </div>
                    <div className="flex items-center gap-3">
                        <span
                            className="hidden sm:inline text-sm text-muted-ink truncate max-w-[200px]"
                            title={user.email}
                        >
                            {user.email}
                        </span>
                        <LogoutButton />
                    </div>
                </div>
            </header>

            <div className="flex flex-1 min-h-0 flex-col md:flex-row">
                <Sidebar resellerStatus={resellerStatus} />
                <main className="flex-1 px-4 sm:px-6 py-6 overflow-y-auto">
                    <div className="max-w-5xl mx-auto">
                        {showUnverifiedBanner && <UnverifiedBanner email={user.email} />}
                        <AnnouncementBanner items={announcements} />
                        {children}
                    </div>
                </main>
            </div>
        </div>
    );
}

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
 * over a `/portal/*` prefix so a future llmroute.club subdomain split
 * doesn't require URL rewrites.
 *
 * W7 P2 visual rebrand
 * --------------------
 * The header stays on one neutral paper surface. Platform branding comes from
 * the transparent plated-gold lockup itself; no separate dark logo panel is
 * introduced. White-label tenants keep the same shell and supply their own
 * logo or text wordmark through BrandLogo.
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
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { UnverifiedBanner } from './unverified-banner';
import { AnnouncementBanner } from './announcement-banner';
import { getActiveAnnouncements } from '@/lib/announcements/fetch-active';
import { CustomerShell } from './customer-shell';

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

    // Tenant color is an interaction accent, never a body-text color. This
    // keeps white-label themes legible while preserving the neutral console.
    const tenant = await getCurrentTenant();
    const isPlatformTenant = tenant.id === PLATFORM_TENANT_ID;
    const brandStyle =
        !isPlatformTenant && tenant.primary_color
            ? ({
                  ['--color-brand-accent']: tenant.primary_color,
                  ['--color-portal-gold']: tenant.primary_color,
              } as CSSProperties)
            : undefined;

    // 运营公告(顶部通栏)— 全局(tenant_id=null)+ 该客户所属租户;client island 按
    // localStorage 关闭。查询抽到 helper 便于 layout 单测 mock(不连 prisma)。
    const announcements = await getActiveAnnouncements(user.tenant_id ?? null);

    return (
        <CustomerShell
            logo={<BrandLogo variant="primary-flat" size={30} />}
            userEmail={user.email}
            resellerStatus={resellerStatus}
            brandStyle={brandStyle}
            notices={
                <>
                    {showUnverifiedBanner && <UnverifiedBanner email={user.email} />}
                    <AnnouncementBanner items={announcements} />
                </>
            }
        >
            {children}
        </CustomerShell>
    );
}

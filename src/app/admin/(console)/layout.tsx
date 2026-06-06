/**
 * Admin console layout — server-side auth gate (P1).
 *
 * Replaces the old `?token=<ADMIN_TOKEN>`-in-URL scheme. Mirrors
 * `(authenticated)/layout.tsx`: read the silkroad_session cookie via
 * getAdminUser, redirect to /admin/login when the visitor isn't a staff+
 * admin. The console pages live in this `(console)` route group so the
 * unguarded /admin/login (a sibling, NOT in the group) is never wrapped by
 * this gate — avoids a redirect loop.
 *
 * getAdminUser requires role >= staff (cookie session only; the ADMIN_TOKEN
 * break-glass is for the API routes / scripts, not for entering the UI).
 * Individual /api/admin/* routes still gate at role >= admin (design §3.1
 * "P1 先统一用 admin"); a hypothetical staff-only user could load the shell
 * but its API calls would 401 — moot in P1 where the only granted role is
 * superadmin.
 */
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/admin/auth';
import { AdminShell } from './admin-shell';

export const dynamic = 'force-dynamic';

/** Bridge headers() → NextRequest so we can reuse getAdminUser. Same pattern
 *  as (authenticated)/layout.tsx + login/page.tsx. */
async function getSessionAdmin() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/admin', { method: 'GET', headers: { cookie } });
    return getAdminUser(req);
}

export default async function AdminConsoleLayout({ children }: { children: ReactNode }) {
    const admin = await getSessionAdmin();
    if (!admin) redirect('/admin/login');
    return <AdminShell adminEmail={admin.email}>{children}</AdminShell>;
}

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
 * P6a §6.2: the console entry gate now requires role >= admin (was staff), to
 * MATCH the /api/admin/* gate (role >= admin). Previously a staff user could
 * load the shell but every API call 401'd (blank pages). Partner operators are
 * granted 'admin' (+ their tenant) — see scripts/grant-admin.ts. The ADMIN_TOKEN
 * break-glass is for API routes / scripts, not for entering the UI.
 */
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/admin/auth';
import { roleAtLeast } from '@/lib/admin/roles';
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
    // role >= admin (P6a §6.2) — consistent with the API gate.
    if (!admin || !roleAtLeast(admin.role, 'admin')) redirect('/admin/login');
    return (
        <AdminShell adminEmail={admin.email} adminRole={admin.role}>
            {children}
        </AdminShell>
    );
}

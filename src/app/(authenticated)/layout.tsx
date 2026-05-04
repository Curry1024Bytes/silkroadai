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
 */
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { Sidebar } from './sidebar';
import { LogoutButton } from './logout-button';
import { UnverifiedBanner } from './unverified-banner';

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
    const path =
        h.get('x-invoke-path') ||
        h.get('x-matched-path') ||
        h.get('next-url') ||
        '';
    if (path && path.startsWith('/') && !path.startsWith('//')) return path;
    return '/dashboard';
}

export default async function AuthenticatedLayout({
    children,
}: {
    children: ReactNode;
}) {
    const user = await getSessionUser();
    if (!user) {
        const next = await getRequestedPath();
        redirect(`/login?next=${encodeURIComponent(next)}`);
    }

    const showUnverifiedBanner = !user.email_verified;

    return (
        <div
            style={{
                minHeight: '100vh',
                background: '#f5f7fa',
                color: '#1a2540',
                display: 'flex',
                flexDirection: 'column',
            }}
        >
            <header
                style={{
                    background: '#0a1535',
                    color: '#fff',
                    padding: '14px 24px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
                }}
            >
                <div>
                    <h1 style={{ margin: 0, fontSize: 18 }}>Silk Road AI</h1>
                    <p style={{ margin: '2px 0 0', fontSize: 11, opacity: 0.7 }}>
                        Connecting Global Intelligence.
                    </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 13, opacity: 0.85 }}>{user.email}</span>
                    <LogoutButton />
                </div>
            </header>

            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                <Sidebar />
                <main
                    style={{
                        flex: 1,
                        padding: 24,
                        overflowY: 'auto',
                    }}
                >
                    {showUnverifiedBanner && <UnverifiedBanner />}
                    {children}
                </main>
            </div>
        </div>
    );
}

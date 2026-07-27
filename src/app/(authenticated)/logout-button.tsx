'use client';

import { useState } from 'react';
import { LoaderCircle, LogOut } from 'lucide-react';

/**
 * Logout button. POSTs /api/auth/logout (clears the silkroad_session cookie
 * server-side, doesn't bump session_token_version — see W3 D4 gotcha #16:
 * full device-kick is reserved for password reset). On success we hard-nav
 * to /login so any cached client state is dropped.
 *
 * Visual: ghost variant on the paper header (was filled-button on the navy
 * pre-W7-P2 header — the chrome flipped to paper, so a ghost reads better).
 */
export function LogoutButton() {
    const [loggingOut, setLoggingOut] = useState(false);

    async function handleLogout() {
        if (loggingOut) return;
        setLoggingOut(true);
        try {
            await fetch('/api/auth/logout', {
                method: 'POST',
                credentials: 'same-origin',
            });
        } catch {
            // Even on network failure we still want to bounce the user out
            // of the authenticated UI — they think they're logged out, the
            // cookie may still linger but server will reject anyway.
        }
        window.location.href = '/login';
    }

    return (
        <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            aria-label={loggingOut ? '退出中' : '退出登录'}
            title={loggingOut ? '退出中' : '退出登录'}
            className="flex h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm text-portal-muted transition-colors duration-200 hover:bg-portal-soft hover:text-portal-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/25 disabled:cursor-wait disabled:opacity-60"
        >
            {loggingOut ? (
                <LoaderCircle size={17} className="animate-spin" aria-hidden="true" />
            ) : (
                <LogOut size={17} strokeWidth={1.8} aria-hidden="true" />
            )}
            <span className="hidden lg:inline">{loggingOut ? '退出中…' : '退出'}</span>
        </button>
    );
}

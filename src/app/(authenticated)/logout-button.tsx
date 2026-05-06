'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';

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
        <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            loading={loggingOut}
        >
            {loggingOut ? '退出中…' : '退出'}
        </Button>
    );
}

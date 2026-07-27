'use client';

/**
 * InviteCodeBridge — fix/invite-landing fallback.
 *
 * When someone shares an older `https://llmroute.club/?invite=X` link
 * (pre-fix, or copy-pasted to an app that strips the path), we don't
 * want to drop the attribution. This client island reads the query
 * string on landing, stores the code in sessionStorage, then the
 * register page's RegisterForm picks it up when the user eventually
 * navigates to /register or /portal/register.
 *
 * Stored under `pendingInviteCode`. Cleared by RegisterForm on
 * successful registration. Same-tab only (sessionStorage), which is the
 * right scope — different-tab visit is a different user intent.
 *
 * No render. Returns null. Mounted at the root of `/` for the fallback
 * + `/register` for symmetry (in case future flows route through a
 * pre-register page).
 */
import { useEffect } from 'react';

const SESSION_STORAGE_KEY = 'pendingInviteCode';
/** Cap the stored value to a defensive length so a malicious link can't
 *  fill sessionStorage with garbage. Backend rejects > 64 chars anyway. */
const MAX_STORED_LENGTH = 64;

export function InviteCodeBridge() {
    useEffect(() => {
        try {
            const params = new URLSearchParams(window.location.search);
            const code = params.get('invite')?.trim();
            if (!code) return;
            const clamped = code.slice(0, MAX_STORED_LENGTH);
            window.sessionStorage.setItem(SESSION_STORAGE_KEY, clamped);
        } catch {
            // sessionStorage / URLSearchParams can throw in odd browser
            // states (e.g. iframe with disabled storage). Non-fatal —
            // the user can still register, just without auto-prefill.
        }
    }, []);
    return null;
}

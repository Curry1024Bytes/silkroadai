import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/auth/session';

// Cookie work + matches the rest of /api/auth — pin runtime.
export const runtime = 'nodejs';

/**
 * POST /api/auth/logout
 *
 * Single-device logout: clears the silkroad_session cookie on the responding
 * client. Does NOT bump `User.session_token_version` — that's a destructive
 * "kick all sessions everywhere" action reserved for password reset
 * (CLAUDE.md gotcha #16). If a future feature needs explicit "log out from
 * everywhere", build a separate /api/auth/logout-everywhere endpoint that
 * does increment the version.
 *
 * Returns 200 unconditionally — there's nothing actionable about being
 * "already logged out" and the client wants to navigate to /login regardless.
 * No CSRF token requirement: the cookie is httpOnly+SameSite=Lax, so a
 * cross-site POST cannot piggyback the session anyway, and worst case an
 * attacker forces a logout — annoying but not a privilege escalation.
 */
export async function POST() {
    const res = NextResponse.json({ ok: true });
    clearSessionCookie(res);
    return res;
}

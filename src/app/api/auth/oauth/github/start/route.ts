import { NextResponse } from 'next/server';
import { buildGitHubAuthorizeUrl, generateState } from '@/lib/auth/oauth/github';

// Uses Node crypto (randomBytes) — pin runtime so Next doesn't try to put
// this on the Edge.
export const runtime = 'nodejs';

const STATE_COOKIE = 'oauth_github_state';
// 10 minutes — covers the user's roundtrip through the GitHub authorize +
// consent screen. Longer than necessary on the happy path; on slowpoke users
// the callback fails with state-mismatch and they restart.
const COOKIE_MAX_AGE_SECONDS = 600;

export async function GET() {
    const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
    const redirectUri = process.env.GITHUB_OAUTH_REDIRECT_URI;

    if (!clientId || !redirectUri) {
        console.error(
            '[oauth/github/start] missing env: GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_REDIRECT_URI must both be set',
        );
        return NextResponse.json({ error: 'oauth_not_configured' }, { status: 503 });
    }

    const state = generateState();
    const authorizeUrl = buildGitHubAuthorizeUrl({ clientId, redirectUri, state });

    const res = NextResponse.redirect(authorizeUrl, { status: 302 });
    res.cookies.set({
        name: STATE_COOKIE,
        value: state,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: COOKIE_MAX_AGE_SECONDS,
    });
    return res;
}

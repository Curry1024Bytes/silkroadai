import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
    exchangeCodeForToken,
    fetchGitHubUser,
    fetchGitHubVerifiedPrimaryEmail,
    GitHubOAuthError,
} from '@/lib/auth/oauth/github';
import { linkOrCreateOAuthUser } from '@/lib/auth/oauth/account-link';
import { signSession, setSessionCookie } from '@/lib/auth/session';

// Uses prisma + Node fetch — pin runtime so Next doesn't try to put this on
// the Edge.
export const runtime = 'nodejs';

const STATE_COOKIE = 'oauth_github_state';
const PROVIDER = 'github';

/**
 * Build the post-flow redirect. On success we land on `/dashboard` (the
 * authenticated client portal landing — W4-2 D7 amend). On failure we land
 * on `/?oauth_error=<code>` so the homepage's query forwarder carries the
 * code through to /pay → /login banner. The state cookie is single-use —
 * see CLAUDE.md gotcha #17 for why we clear it on every exit path.
 */
function buildResponse(reqUrl: string, opts: { error?: string } = {}): NextResponse {
    const path = opts.error ? '/' : '/dashboard';
    const base = new URL(path, reqUrl);
    if (opts.error) base.searchParams.set('oauth_error', opts.error);
    const res = NextResponse.redirect(base, { status: 302 });
    clearOAuthCookies(res);
    return res;
}

function clearOAuthCookies(res: NextResponse): void {
    res.cookies.set({
        name: STATE_COOKIE,
        value: '',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
    });
}

export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const stateFromQuery = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');

    if (oauthError) {
        // GitHub bounced the user back with an error (typically because they
        // hit "Cancel" on the authorize screen). Surface as github_denied;
        // not worth a console.error since it's a normal user choice.
        return buildResponse(req.url, { error: 'github_denied' });
    }
    if (!code || !stateFromQuery) {
        return buildResponse(req.url, { error: 'missing_code_or_state' });
    }

    const stateCookie = req.cookies.get(STATE_COOKIE)?.value;
    if (!stateCookie || stateCookie !== stateFromQuery) {
        return buildResponse(req.url, { error: 'state_mismatch' });
    }

    const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
    const redirectUri = process.env.GITHUB_OAUTH_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
        console.error(
            '[oauth/github/callback] missing env: GITHUB_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI must all be set',
        );
        return buildResponse(req.url, { error: 'oauth_not_configured' });
    }

    let providerAccountId: string;
    let email: string;
    let nameHint: string | null;
    try {
        const tokenRes = await exchangeCodeForToken({
            code,
            clientId,
            clientSecret,
            redirectUri,
        });
        const ghUser = await fetchGitHubUser(tokenRes.access_token);
        const primaryEmail = await fetchGitHubVerifiedPrimaryEmail(tokenRes.access_token);
        providerAccountId = String(ghUser.id);
        email = primaryEmail;
        nameHint = ghUser.name ?? ghUser.login;
    } catch (err) {
        if (err instanceof GitHubOAuthError) {
            console.warn(`[oauth/github/callback] ${err.code}: ${err.message}`);
            return buildResponse(req.url, { error: err.code });
        }
        console.error('[oauth/github/callback] unexpected token/identity failure:', err);
        return buildResponse(req.url, { error: 'oauth_failed' });
    }

    const outcome = await linkOrCreateOAuthUser({
        provider: PROVIDER,
        providerAccountId,
        email,
        nameHint,
    });
    if (!outcome.ok) {
        return buildResponse(req.url, { error: outcome.error });
    }

    // Touch last_login_at, fire-and-forget. Same pattern as login route /
    // google callback.
    prisma.user
        .update({ where: { id: outcome.userId }, data: { last_login_at: new Date() } })
        .catch((err) => {
            console.warn(
                `[oauth/github/callback] last_login_at update failed for ${outcome.userId}:`,
                err,
            );
        });

    const sessionToken = await signSession(outcome.userId);
    const res = buildResponse(req.url);
    setSessionCookie(res, sessionToken);
    return res;
}

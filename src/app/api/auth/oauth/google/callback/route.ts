import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
    exchangeCodeForTokens,
    verifyGoogleIdToken,
    GoogleOAuthError,
    type GoogleIdTokenClaims,
} from '@/lib/auth/oauth/google';
import { linkOrCreateOAuthUser } from '@/lib/auth/oauth/account-link';
import { signSession, setSessionCookie } from '@/lib/auth/session';

// Uses prisma + jose + Node fetch — pin runtime so Next doesn't try to put
// this on the Edge.
export const runtime = 'nodejs';

const STATE_COOKIE = 'oauth_google_state';
const PKCE_COOKIE = 'oauth_google_pkce';
const PROVIDER = 'google';

/**
 * Build the post-flow redirect. On success we land on `/` with the session
 * cookie attached; on failure we land on `/?oauth_error=<code>` so the
 * homepage can surface a banner. We always clear the state + pkce cookies on
 * the way out (they are single-use, exposing them to a second callback would
 * widen the CSRF window — see CLAUDE.md gotcha #17).
 */
function buildResponse(reqUrl: string, opts: { error?: string } = {}): NextResponse {
    const base = new URL('/', reqUrl);
    if (opts.error) base.searchParams.set('oauth_error', opts.error);
    const res = NextResponse.redirect(base, { status: 302 });
    clearOAuthCookies(res);
    return res;
}

function clearOAuthCookies(res: NextResponse): void {
    const isProd = process.env.NODE_ENV === 'production';
    const opts = {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax' as const,
        path: '/',
        maxAge: 0,
    };
    res.cookies.set({ name: STATE_COOKIE, value: '', ...opts });
    res.cookies.set({ name: PKCE_COOKIE, value: '', ...opts });
}

export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const stateFromQuery = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');

    // Google bounced the user back with an error (e.g. they hit "deny" on
    // the consent screen). Surface a friendly code so the homepage can show a
    // banner — no need to log loudly, this is a normal user choice.
    if (oauthError) {
        return buildResponse(req.url, { error: 'google_denied' });
    }

    if (!code || !stateFromQuery) {
        return buildResponse(req.url, { error: 'missing_code_or_state' });
    }

    const stateCookie = req.cookies.get(STATE_COOKIE)?.value;
    const pkceCookie = req.cookies.get(PKCE_COOKIE)?.value;

    // Both cookies must exist AND state must match. Cookie absence means the
    // user came in cold (bookmarked callback URL?) or cookies were stripped
    // by sameSite — either way we can't trust the request.
    if (!stateCookie || !pkceCookie || stateCookie !== stateFromQuery) {
        return buildResponse(req.url, { error: 'state_mismatch' });
    }

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
        console.error(
            '[oauth/google/callback] missing env: GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI must all be set',
        );
        return buildResponse(req.url, { error: 'oauth_not_configured' });
    }

    let claims: GoogleIdTokenClaims;
    try {
        const tokens = await exchangeCodeForTokens({
            code,
            codeVerifier: pkceCookie,
            clientId,
            clientSecret,
            redirectUri,
        });
        claims = await verifyGoogleIdToken({
            idToken: tokens.id_token,
            clientId,
        });
    } catch (err) {
        if (err instanceof GoogleOAuthError) {
            console.warn(`[oauth/google/callback] ${err.code}: ${err.message}`);
            return buildResponse(req.url, { error: err.code });
        }
        console.error('[oauth/google/callback] unexpected token/verify failure:', err);
        return buildResponse(req.url, { error: 'oauth_failed' });
    }

    // W4-1 D3 sweep: 5-branch email-conflict logic now goes through the
    // shared helper (same one GitHub callback uses since W3 D7). Behavior
    // is identical to the inline version this replaced — verified by D6's
    // 15-test suite still passing unchanged.
    const outcome = await linkOrCreateOAuthUser({
        provider: PROVIDER,
        providerAccountId: claims.sub,
        email: claims.email,
        nameHint: claims.name,
    });
    if (!outcome.ok) {
        return buildResponse(req.url, { error: outcome.error });
    }
    const userId = outcome.userId;

    // Touch last_login_at, fire-and-forget. Same pattern as login route.
    prisma.user
        .update({ where: { id: userId }, data: { last_login_at: new Date() } })
        .catch((err) => {
            console.warn(`[oauth/google/callback] last_login_at update failed for ${userId}:`, err);
        });

    const sessionToken = await signSession(userId);
    const res = buildResponse(req.url);
    setSessionCookie(res, sessionToken);
    return res;
}

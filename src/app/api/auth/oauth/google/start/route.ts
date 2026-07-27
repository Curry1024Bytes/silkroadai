import { NextResponse } from 'next/server';
import { brandCookieDomain } from '@/lib/auth/session';
import {
    buildGoogleAuthorizeUrl,
    generatePkceVerifier,
    generateState,
    pkceChallengeFromVerifier,
} from '@/lib/auth/oauth/google';

// Uses Node crypto (randomBytes / createHash) — pin runtime so Next doesn't
// try to put this on the Edge.
export const runtime = 'nodejs';

const STATE_COOKIE = 'oauth_google_state';
const PKCE_COOKIE = 'oauth_google_pkce';
// 10 minutes — covers the user's roundtrip through the Google consent screen.
// If they take longer, callback fails with state-mismatch and they restart;
// that's fine.
const COOKIE_MAX_AGE_SECONDS = 600;

export async function GET() {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

    if (!clientId || !redirectUri) {
        console.error(
            '[oauth/google/start] missing env: GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_REDIRECT_URI must both be set',
        );
        return NextResponse.json({ error: 'oauth_not_configured' }, { status: 503 });
    }

    const state = generateState();
    const codeVerifier = generatePkceVerifier();
    const codeChallenge = pkceChallengeFromVerifier(codeVerifier);

    const authorizeUrl = buildGoogleAuthorizeUrl({
        clientId,
        redirectUri,
        state,
        codeChallenge,
    });

    const res = NextResponse.redirect(authorizeUrl, { status: 302 });
    const isProd = process.env.NODE_ENV === 'production';
    const cookieOpts = {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax' as const,
        path: '/',
        maxAge: COOKIE_MAX_AGE_SECONDS,
        // W7 D3 amend: scope to BRAND_COOKIE_DOMAIN (".llmroute.club" in
        // prod) so the apex-issued state/pkce cookies survive the round-
        // trip through Google → callback at the same eTLD+1 even when the
        // callback URI host briefly differs from the start URI host
        // (transient portal subdomain still serves the same app until
        // Caddy 301 fully drains).
        domain: brandCookieDomain(),
    };
    res.cookies.set({ name: STATE_COOKIE, value: state, ...cookieOpts });
    res.cookies.set({ name: PKCE_COOKIE, value: codeVerifier, ...cookieOpts });
    return res;
}

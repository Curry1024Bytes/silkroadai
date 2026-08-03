import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import {
    exchangeCodeForTokens,
    verifyGoogleIdToken,
    GoogleOAuthError,
    type GoogleIdTokenClaims,
} from '@/lib/auth/oauth/google';
import { linkOrCreateOAuthUser } from '@/lib/auth/oauth/account-link';
import { resolveTenantByHost } from '@/lib/tenant/resolve';
import { signSession, setSessionCookie, brandCookieDomain } from '@/lib/auth/session';
import { extractClientIP } from '@/lib/auth/extract-ip';

// Uses prisma + jose + Node fetch — pin runtime so Next doesn't try to put
// this on the Edge.
export const runtime = 'nodejs';

const STATE_COOKIE = 'oauth_google_state';
const PKCE_COOKIE = 'oauth_google_pkce';
const PROVIDER = 'google';

/**
 * Build the post-flow redirect. On success we land on `/dashboard` (the
 * authenticated client portal landing — W4-2 D7 amend). On failure we land
 * on `/?oauth_error=<code>` so the homepage's query forwarder (src/app/
 * page.tsx) carries the code through to /pay → /login banner. We always
 * clear the state + pkce cookies on the way out (they are single-use,
 * exposing them to a second callback would widen the CSRF window — see
 * CLAUDE.md gotcha #17).
 *
 * W5 D3 fix-up: prefer APP_URL (or its NEXT_PUBLIC_APP_URL fallback) over
 * reqUrl for the redirect base.
 *
 * Two-layer reasoning:
 *   1. Behind a reverse proxy, Next.js 16 standalone constructs
 *      `request.url` from the container's HOSTNAME env (=0.0.0.0 in our
 *      docker setup), not the proxy's Host header. Naive `new URL(path,
 *      reqUrl)` in prod yields `https://0.0.0.0:3002/dashboard?…`.
 *   2. NEXT_PUBLIC_-prefixed env vars are inlined into the build at
 *      `next build` time (Next.js does this so SSR + CSR see the same
 *      value). Changing NEXT_PUBLIC_APP_URL on the running container has
 *      no effect on server-side reads — they resolve to whatever was set
 *      during build. Compose now supplies the production value to the image,
 *      but APP_URL still comes first as a plain runtime env var picked up
 *      from docker-compose env_file. We then fall back to
 *      NEXT_PUBLIC_APP_URL (matches build-time value if APP_URL unset)
 *      and finally to reqUrl (keeps unit tests + non-proxied dev green).
 */
function buildResponse(reqUrl: string, opts: { error?: string } = {}): NextResponse {
    const path = opts.error ? '/' : '/dashboard';
    const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || reqUrl;
    const base = new URL(path, appUrl);
    if (opts.error) base.searchParams.set('oauth_error', opts.error);
    const res = NextResponse.redirect(base, { status: 302 });
    clearOAuthCookies(res);
    return res;
}

function clearOAuthCookies(res: NextResponse): void {
    const isProd = process.env.NODE_ENV === 'production';
    // Domain MUST match the start handler's setter; otherwise the browser
    // treats this as setting a different cookie and the original lingers
    // (CLAUDE.md gotcha #17 — single-use OAuth cookies leaking across
    // failure paths).
    const opts = {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax' as const,
        path: '/',
        maxAge: 0,
        domain: brandCookieDomain(),
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
        // W5 D4: GoogleOAuthError is "expected" (bad code, expired id_token,
        // etc — surface to user, no alert). Anything else slipping through is
        // a real problem (jose lib bug, network, etc) — Sentry it.
        Sentry.captureException(err, { tags: { area: 'oauth-google-callback' } });
        return buildResponse(req.url, { error: 'oauth_failed' });
    }

    // W4-1 D3 sweep: 5-branch email-conflict logic now goes through the
    // shared helper (same one GitHub callback uses since W3 D7). Behavior
    // is identical to the inline version this replaced — verified by D6's
    // 15-test suite still passing unchanged.
    // P6a: attribute a new OAuth signup to the request-domain's tenant.
    // P6b-2 §3.2: pass signup_enabled — a tenant with self-serve signup OFF rejects
    // BRAND-NEW OAuth signups (existing users still log in).
    const tenant = await resolveTenantByHost(req.headers.get('host'));
    const outcome = await linkOrCreateOAuthUser(
        {
            provider: PROVIDER,
            providerAccountId: claims.sub,
            email: claims.email,
            nameHint: claims.name,
        },
        tenant.id,
        tenant.signup_enabled,
    );
    if (!outcome.ok) {
        // W5 D4: provisioning_failed is operational (new-api flake or our
        // rollback path failed) → Sentry. account_disabled is banned-user
        // login attempt; link_conflict is "different portal user already
        // owns this oauth identity" (suspected attack) — neither is an
        // ops alert.
        if (outcome.error === 'provisioning_failed') {
            Sentry.captureException(new Error(`oauth-google: provisionNewCustomer failed for email=${claims.email}`), {
                tags: { area: 'oauth-google-provision' },
            });
        }
        return buildResponse(req.url, { error: outcome.error });
    }
    const userId = outcome.userId;

    // Touch last_login_at + last_login_ip, fire-and-forget (W5 D4: ip).
    const ip = extractClientIP(req);
    prisma.user
        .update({
            where: { id: userId },
            data: { last_login_at: new Date(), last_login_ip: ip },
        })
        .catch((err) => {
            console.warn(`[oauth/google/callback] last_login update failed for ${userId}:`, err);
        });

    const sessionToken = await signSession(userId);
    const res = buildResponse(req.url);
    setSessionCookie(res, sessionToken);
    return res;
}

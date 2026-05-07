import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import {
    exchangeCodeForToken,
    fetchGitHubUser,
    fetchGitHubVerifiedPrimaryEmail,
    GitHubOAuthError,
} from '@/lib/auth/oauth/github';
import { linkOrCreateOAuthUser } from '@/lib/auth/oauth/account-link';
import { signSession, setSessionCookie, brandCookieDomain } from '@/lib/auth/session';
import { extractClientIP } from '@/lib/auth/extract-ip';

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
 *      no effect on server-side reads. So we read APP_URL first (a plain
 *      runtime env var, picked up live from docker-compose env_file) and
 *      fall back to NEXT_PUBLIC_APP_URL (matches build-time value) and
 *      finally to reqUrl (keeps unit tests + non-proxied dev green).
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
    // Domain MUST match the start handler's setter; otherwise the browser
    // treats this as setting a different cookie and the original lingers
    // (CLAUDE.md gotcha #17 — single-use OAuth cookies leaking across
    // failure paths).
    res.cookies.set({
        name: STATE_COOKIE,
        value: '',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
        domain: brandCookieDomain(),
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
        // W5 D4: GitHubOAuthError is "expected" (sig fail / email not verified
        // / etc) — surface to user, no alert. Anything else is a real ops
        // problem (network / GitHub API outage / etc) — Sentry it.
        Sentry.captureException(err, { tags: { area: 'oauth-github-callback' } });
        return buildResponse(req.url, { error: 'oauth_failed' });
    }

    const outcome = await linkOrCreateOAuthUser({
        provider: PROVIDER,
        providerAccountId,
        email,
        nameHint,
    });
    if (!outcome.ok) {
        // W5 D4: provisioning_failed = new-api flake / our rollback failed.
        // account_disabled (banned) and link_conflict (suspected attack) →
        // not ops alerts.
        if (outcome.error === 'provisioning_failed') {
            Sentry.captureException(
                new Error(`oauth-github: provisionNewCustomer failed for email=${email}`),
                { tags: { area: 'oauth-github-provision' } },
            );
        }
        return buildResponse(req.url, { error: outcome.error });
    }

    // Touch last_login_at + last_login_ip, fire-and-forget (W5 D4: ip).
    const ip = extractClientIP(req);
    prisma.user
        .update({
            where: { id: outcome.userId },
            data: { last_login_at: new Date(), last_login_ip: ip },
        })
        .catch((err) => {
            console.warn(
                `[oauth/github/callback] last_login update failed for ${outcome.userId}:`,
                err,
            );
        });

    const sessionToken = await signSession(outcome.userId);
    const res = buildResponse(req.url);
    setSessionCookie(res, sessionToken);
    return res;
}

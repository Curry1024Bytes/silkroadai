import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
    exchangeCodeForTokens,
    verifyGoogleIdToken,
    GoogleOAuthError,
    type GoogleIdTokenClaims,
} from '@/lib/auth/oauth/google';
import {
    provisionNewCustomer,
    deleteUser as deleteNewApiUser,
    searchUser as searchNewApiUser,
    type ProvisionedCustomer,
} from '@/lib/newapi/client';
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
 * widen the CSRF window).
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

/**
 * Best-effort cleanup of any new-api user that may have been created before
 * provisionNewCustomer threw. Mirrors register/route.ts:cleanupOrphanNewApiUser
 * — same deterministic `c-{portal_uuid8}` username convention.
 */
async function cleanupOrphanNewApiUser(portalUserId: string, contextEmail: string): Promise<void> {
    const username = `c-${portalUserId.slice(0, 8)}`;
    try {
        const search = await searchNewApiUser(username, 1, 5);
        const orphan = search.items.find((u) => u.username === username);
        if (orphan) {
            await deleteNewApiUser(orphan.id);
            console.warn(
                `[oauth/google/callback] cleaned orphan new-api user id=${orphan.id} username=${username} after provision failure for ${contextEmail}`,
            );
        }
    } catch (err) {
        console.error(
            `[oauth/google/callback] orphan new-api cleanup failed for ${contextEmail} (username=${username}):`,
            err,
        );
    }
}

/**
 * Provision a brand-new portal user for a Google identity that has never been
 * seen before. Mirrors register/route.ts but skips the password (OAuth-only)
 * and sets email_verified=true (Google already proved it). Same rollback
 * dance: provision → linkage → if any step fails, undo both sides.
 *
 * On success: returns the persisted user id ready for signSession().
 * On failure: returns null after logging + cleaning up.
 */
async function createUserFromGoogle(claims: GoogleIdTokenClaims): Promise<string | null> {
    let user;
    try {
        user = await prisma.user.create({
            data: {
                email: claims.email,
                password_hash: null,
                nickname: claims.name?.slice(0, 64) || null,
                email_verified: true,
                email_verified_at: new Date(),
                oauth_accounts: {
                    create: {
                        provider: PROVIDER,
                        provider_account_id: claims.sub,
                    },
                },
            },
            select: { id: true },
        });
    } catch (err) {
        console.error(
            `[oauth/google/callback] portal user create failed for ${claims.email}:`,
            err,
        );
        return null;
    }

    let provisioned: ProvisionedCustomer;
    try {
        provisioned = await provisionNewCustomer({
            portal_user_id: user.id,
            email: claims.email,
            initial_quota: 0,
        });
    } catch (provisionErr) {
        await cleanupOrphanNewApiUser(user.id, claims.email);
        await prisma.user.delete({ where: { id: user.id } }).catch((deleteErr) => {
            console.error(
                `[oauth/google/callback] new-api provision failed AND portal rollback failed for user ${user.id}:`,
                deleteErr,
            );
        });
        console.error(
            `[oauth/google/callback] provisionNewCustomer failed for ${claims.email}:`,
            provisionErr,
        );
        return null;
    }

    try {
        await prisma.$transaction([
            prisma.user.update({
                where: { id: user.id },
                data: {
                    newapi_user_id: provisioned.newapi_user_id,
                    newapi_username: provisioned.newapi_username,
                    newapi_access_token: provisioned.newapi_access_token,
                },
            }),
            prisma.newApiToken.create({
                data: {
                    user_id: user.id,
                    newapi_token_id: provisioned.newapi_token_id,
                    newapi_token_value: provisioned.newapi_token_value,
                    key_alias: `default-${user.id.slice(0, 8)}`,
                },
            }),
        ]);
    } catch (linkageErr) {
        const tokenPreview = typeof provisioned.newapi_token_value === 'string'
            ? `${provisioned.newapi_token_value.slice(0, 12)}...`
            : `<${typeof provisioned.newapi_token_value}>`;
        console.error(
            `[oauth/google/callback] new-api provision succeeded for ${user.id} ` +
                `(newapi_user_id=${provisioned.newapi_user_id}, ` +
                `token=${tokenPreview}) ` +
                `but persisting linkage failed — rolling back both sides:`,
            linkageErr,
        );
        await deleteNewApiUser(provisioned.newapi_user_id).catch((err) =>
            console.error(`[oauth/google/callback] new-api user cleanup failed for ${provisioned.newapi_user_id}:`, err),
        );
        await prisma.user.delete({ where: { id: user.id } }).catch((err) =>
            console.error(`[oauth/google/callback] portal user cleanup failed for ${user.id}:`, err),
        );
        return null;
    }

    return user.id;
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

    // Branch 1 — existing oauth_account: the (provider, sub) pair has been
    // seen before. Trust it and log the linked user in. No email lookup; the
    // sub is more stable than email anyway (users can change their gmail
    // address but the sub stays put).
    const existingLink = await prisma.oAuthAccount.findUnique({
        where: {
            provider_provider_account_id: {
                provider: PROVIDER,
                provider_account_id: claims.sub,
            },
        },
        select: { user: { select: { id: true, status: true, email: true } } },
    });

    let userId: string | null = null;

    if (existingLink) {
        if (existingLink.user.status !== 'active') {
            return buildResponse(req.url, { error: 'account_disabled' });
        }
        userId = existingLink.user.id;
    } else {
        // No link yet. Look up by email to decide between branches 2/3/4/5.
        const userByEmail = await prisma.user.findUnique({
            where: { email: claims.email },
            select: { id: true, status: true, email_verified: true },
        });

        if (userByEmail) {
            if (userByEmail.status !== 'active') {
                return buildResponse(req.url, { error: 'account_disabled' });
            }

            // Branch 2 (link-verified) and Branch 3 (bootstrap-unverified) both
            // create the oauth_account row in the same transaction. The only
            // difference is whether we also flip email_verified. We treat the
            // Google-asserted email as proof — if our DB previously had
            // email_verified=false, the Google login bootstraps it to true.
            try {
                if (userByEmail.email_verified) {
                    await prisma.oAuthAccount.create({
                        data: {
                            user_id: userByEmail.id,
                            provider: PROVIDER,
                            provider_account_id: claims.sub,
                        },
                    });
                } else {
                    await prisma.$transaction([
                        prisma.user.update({
                            where: { id: userByEmail.id },
                            data: {
                                email_verified: true,
                                email_verified_at: new Date(),
                            },
                        }),
                        prisma.oAuthAccount.create({
                            data: {
                                user_id: userByEmail.id,
                                provider: PROVIDER,
                                provider_account_id: claims.sub,
                            },
                        }),
                    ]);
                }
            } catch (err) {
                // Branch 5 (sub-conflict): the same sub already linked to a
                // DIFFERENT portal user. Shouldn't normally happen — would
                // mean two portal accounts share a Google identity. Reject
                // rather than silently move the link.
                console.warn(
                    `[oauth/google/callback] failed to link existing user ${userByEmail.id} to google sub=${claims.sub}:`,
                    err,
                );
                return buildResponse(req.url, { error: 'link_conflict' });
            }
            userId = userByEmail.id;
        } else {
            // Branch 4 — fresh signup. No portal user with this email, no
            // existing link. Create the user + provision new-api side + link.
            const createdId = await createUserFromGoogle(claims);
            if (!createdId) {
                return buildResponse(req.url, { error: 'provisioning_failed' });
            }
            userId = createdId;
        }
    }

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

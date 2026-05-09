/**
 * Shared OAuth identity → portal user resolver.
 *
 * Implements the 5-branch email conflict policy used by every OAuth provider
 * we add. Behavior is intentionally identical to the inline logic in
 * `src/app/api/auth/oauth/google/callback/route.ts` (W3 D6) — that route
 * predates this helper and is left untouched per the W3 D7 brief, but a
 * future PR can refactor it to call this. New providers (GitHub W3 D7
 * onward) should use this helper.
 *
 * Branches:
 *   1. existing (provider, providerAccountId) → return that user
 *   2. no link, email matches a verified portal user → silent link
 *   3. no link, email matches an UNverified portal user → bootstrap-verify + link
 *   4. no link, email is brand new → create user (verified, no password) +
 *      provisionNewCustomer + persist linkage; rollback on any failure
 *   5. (caught implicitly) the providerAccountId is already linked to a
 *      DIFFERENT portal user — link create throws unique violation, we
 *      surface 'link_conflict' rather than silently moving the link.
 *
 * Caller responsibility: ensure the email arrived through a path that proves
 * the user controls it (Google id_token email_verified=true, GitHub primary
 * verified email, etc). This helper does not re-verify.
 */
import { prisma } from '@/lib/db';
import {
    provisionNewCustomer,
    deleteUser as deleteNewApiUser,
    searchUser as searchNewApiUser,
    type ProvisionedCustomer,
} from '@/lib/newapi/client';

export interface OAuthIdentity {
    /** 'google', 'github', etc — matches `oauth_accounts.provider`. */
    provider: string;
    /** Stable per-user identifier from the provider. */
    providerAccountId: string;
    /** Already-verified, lowercased email. */
    email: string;
    /** Optional display name to seed `User.nickname` for new accounts. */
    nameHint?: string | null;
}

export type LinkOrCreateOutcome =
    | { ok: true; userId: string; branch: 1 | 2 | 3 | 4 }
    | { ok: false; error: 'account_disabled' | 'link_conflict' | 'provisioning_failed' };

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
                `[oauth/account-link] cleaned orphan new-api user id=${orphan.id} username=${username} after provision failure for ${contextEmail}`,
            );
        }
    } catch (err) {
        console.error(
            `[oauth/account-link] orphan new-api cleanup failed for ${contextEmail} (username=${username}):`,
            err,
        );
    }
}

/**
 * Branch 4 — fresh signup. Creates the portal user with password_hash=null
 * and email_verified=true (provider already vouched), then provisions the
 * new-api side, then persists linkage. Rolls back both sides on any failure.
 *
 * Returns the new userId on success, null on failure (caller maps to
 * 'provisioning_failed').
 */
async function createUserFromIdentity(identity: OAuthIdentity): Promise<string | null> {
    let user;
    try {
        user = await prisma.user.create({
            data: {
                email: identity.email,
                password_hash: null,
                nickname: identity.nameHint?.slice(0, 64) || null,
                email_verified: true,
                email_verified_at: new Date(),
                oauth_accounts: {
                    create: {
                        provider: identity.provider,
                        provider_account_id: identity.providerAccountId,
                    },
                },
            },
            select: { id: true },
        });
    } catch (err) {
        console.error(
            `[oauth/account-link] portal user create failed for ${identity.email} (provider=${identity.provider}):`,
            err,
        );
        return null;
    }

    let provisioned: ProvisionedCustomer;
    try {
        provisioned = await provisionNewCustomer({
            portal_user_id: user.id,
            email: identity.email,
            initial_quota: 0,
        });
    } catch (provisionErr) {
        await cleanupOrphanNewApiUser(user.id, identity.email);
        await prisma.user.delete({ where: { id: user.id } }).catch((deleteErr) => {
            console.error(
                `[oauth/account-link] new-api provision failed AND portal rollback failed for user ${user.id}:`,
                deleteErr,
            );
        });
        console.error(`[oauth/account-link] provisionNewCustomer failed for ${identity.email}:`, provisionErr);
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
        const tokenPreview =
            typeof provisioned.newapi_token_value === 'string'
                ? `${provisioned.newapi_token_value.slice(0, 12)}...`
                : `<${typeof provisioned.newapi_token_value}>`;
        console.error(
            `[oauth/account-link] new-api provision succeeded for ${user.id} ` +
                `(newapi_user_id=${provisioned.newapi_user_id}, ` +
                `token=${tokenPreview}) ` +
                `but persisting linkage failed — rolling back both sides:`,
            linkageErr,
        );
        await deleteNewApiUser(provisioned.newapi_user_id).catch((err) =>
            console.error(`[oauth/account-link] new-api user cleanup failed for ${provisioned.newapi_user_id}:`, err),
        );
        await prisma.user
            .delete({ where: { id: user.id } })
            .catch((err) => console.error(`[oauth/account-link] portal user cleanup failed for ${user.id}:`, err));
        return null;
    }

    // PR-T1 Phase 0c — eagerly provision the portal system token used by
    // server-managed services (image gen / future internal flows). Mirrors
    // the same hook in /api/auth/register. Best-effort: failure logged
    // but doesn't roll back the OAuth account; first portal-managed call
    // retries lazily.
    try {
        const { getOrCreateSystemToken } = await import('@/lib/newapi/system-token');
        await getOrCreateSystemToken(user.id);
    } catch (sysTokErr) {
        console.warn(
            `[oauth/account-link] portal system token eager-provision failed for ${user.id} (will retry lazily on first portal-managed call):`,
            sysTokErr,
        );
    }

    return user.id;
}

export async function linkOrCreateOAuthUser(identity: OAuthIdentity): Promise<LinkOrCreateOutcome> {
    // Branch 1 — existing oauth_account: trust the (provider, account_id) pair.
    // No email lookup; the providerAccountId is more stable than email anyway
    // (users can change their primary email but the provider id stays put).
    const existingLink = await prisma.oAuthAccount.findUnique({
        where: {
            provider_provider_account_id: {
                provider: identity.provider,
                provider_account_id: identity.providerAccountId,
            },
        },
        select: { user: { select: { id: true, status: true } } },
    });

    if (existingLink) {
        if (existingLink.user.status !== 'active') {
            return { ok: false, error: 'account_disabled' };
        }
        return { ok: true, userId: existingLink.user.id, branch: 1 };
    }

    // No link yet. Look up by email for branches 2/3 vs branch 4.
    const userByEmail = await prisma.user.findUnique({
        where: { email: identity.email },
        select: { id: true, status: true, email_verified: true },
    });

    if (userByEmail) {
        if (userByEmail.status !== 'active') {
            return { ok: false, error: 'account_disabled' };
        }

        // Branch 2 (link-verified) vs Branch 3 (bootstrap-unverified): only
        // difference is whether we also flip email_verified. The provider has
        // already proved control of this email, so we promote unverified portal
        // accounts to verified on first OAuth login.
        try {
            if (userByEmail.email_verified) {
                await prisma.oAuthAccount.create({
                    data: {
                        user_id: userByEmail.id,
                        provider: identity.provider,
                        provider_account_id: identity.providerAccountId,
                    },
                });
                return { ok: true, userId: userByEmail.id, branch: 2 };
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
                            provider: identity.provider,
                            provider_account_id: identity.providerAccountId,
                        },
                    }),
                ]);
                return { ok: true, userId: userByEmail.id, branch: 3 };
            }
        } catch (err) {
            // Branch 5 — the same providerAccountId already links to a
            // DIFFERENT portal user. We refuse rather than silently moving
            // the link (would let an attacker hijack accounts by registering
            // a portal user with someone else's GitHub email then logging in).
            console.warn(
                `[oauth/account-link] failed to link existing user ${userByEmail.id} to ${identity.provider} account_id=${identity.providerAccountId}:`,
                err,
            );
            return { ok: false, error: 'link_conflict' };
        }
    }

    // Branch 4 — brand new email. Create user + provision + link.
    const createdId = await createUserFromIdentity(identity);
    if (!createdId) {
        return { ok: false, error: 'provisioning_failed' };
    }
    return { ok: true, userId: createdId, branch: 4 };
}

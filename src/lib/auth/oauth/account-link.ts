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
 *   4. no link, email is brand new → create user (verified, no password),
 *      persist linkage, and queue durable new-api provisioning atomically
 *   5. (caught implicitly) the providerAccountId is already linked to a
 *      DIFFERENT portal user — link create throws unique violation, we
 *      surface 'link_conflict' rather than silently moving the link.
 *
 * Caller responsibility: ensure the email arrived through a path that proves
 * the user controls it (Google id_token email_verified=true, GitHub primary
 * verified email, etc). This helper does not re-verify.
 */
import { prisma } from '@/lib/db';
import { withCustomerKeyMutation } from '@/lib/newapi/customer-key-mutation';
import { getDefaultChannelGroup } from '@/lib/channel-group';
import { enqueueCustomerProvisioningJob } from '@/lib/auth/customer-provisioning-queue';

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
    | { ok: false; error: 'account_disabled' | 'link_conflict' | 'provisioning_failed' | 'signup_disabled' };

/**
 *
 * Returns the new userId on success, null on failure (caller maps to
 * 'provisioning_failed'). The new-api setup itself runs asynchronously.
 */
async function createUserFromIdentity(identity: OAuthIdentity, tenantId?: string): Promise<string | null> {
    let defaultGroup;
    try {
        defaultGroup = await getDefaultChannelGroup(tenantId ?? null);
    } catch (err) {
        console.error(
            `[oauth/account-link] default channel group unavailable for tenant ${tenantId ?? 'platform'} ` +
                `(provider=${identity.provider}):`,
            err,
        );
        return null;
    }

    try {
        return await withCustomerKeyMutation(
            {
                tenantId: tenantId ?? null,
                tierKey: defaultGroup.key,
                newapiGroup: defaultGroup.newapi_group,
                requireDefault: true,
            },
            async (tx) => {
                const user = await tx.user.create({
                    data: {
                        email: identity.email,
                        password_hash: null,
                        nickname: identity.nameHint?.slice(0, 64) || null,
                        email_verified: true,
                        email_verified_at: new Date(),
                        tenant_id: tenantId ?? null,
                        oauth_accounts: {
                            create: {
                                provider: identity.provider,
                                provider_account_id: identity.providerAccountId,
                            },
                        },
                    },
                    select: { id: true },
                });
                await enqueueCustomerProvisioningJob(tx, {
                    userId: user.id,
                    email: identity.email,
                    tierKey: defaultGroup.key,
                    newapiGroup: defaultGroup.newapi_group,
                    initialQuota: 0,
                });
                return user.id;
            },
        );
    } catch (err) {
        console.error(
            `[oauth/account-link] portal user + provisioning job create failed for ${identity.email} (provider=${identity.provider}):`,
            err,
        );
        return null;
    }
}

/**
 * @param signupEnabled — the request-domain tenant's `signup_enabled`. When false,
 *   only branch 4 (creating a BRAND-NEW user) is refused → `signup_disabled`. Existing
 *   users (branches 1/2/3 — login / link) are unaffected: closing self-serve signup must
 *   not lock out customers who already have accounts. Default true (back-compat: callers
 *   that don't pass it allow signup, preserving pre-P6b-2 behavior). P6b-2 §3.2.
 */
export async function linkOrCreateOAuthUser(
    identity: OAuthIdentity,
    tenantId?: string,
    signupEnabled: boolean = true,
): Promise<LinkOrCreateOutcome> {
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

    // Branch 4 — brand new email → this would CREATE a new user. If the tenant has
    // disabled self-serve signup, refuse here (mirrors register/route.ts which rejects
    // signup_disabled before creating). Branches 1/2/3 above already returned, so a
    // disabled tenant still lets existing users log in / link.
    if (!signupEnabled) {
        return { ok: false, error: 'signup_disabled' };
    }

    // Brand new email. Create user + link + durable provisioning job.
    const createdId = await createUserFromIdentity(identity, tenantId);
    if (!createdId) {
        return { ok: false, error: 'provisioning_failed' };
    }
    return { ok: true, userId: createdId, branch: 4 };
}

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { hash } from 'bcryptjs';
import { randomBytes, createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
    provisionNewCustomer,
    deleteUser as deleteNewApiUser,
    searchUser as searchNewApiUser,
    type ProvisionedCustomer,
} from '@/lib/newapi/client';
import { signSession, setSessionCookie } from '@/lib/auth/session';
import { sendVerificationEmail } from '@/lib/email/send';
import { getAppUrl } from '@/lib/url/app-url';
import { extractClientIP } from '@/lib/auth/extract-ip';
import { resolveInviteCode, checkIpThrottleAndFlag } from '@/lib/reseller/register-helper';
import { record as recordAnalytics } from '@/lib/analytics/recorder';
import { resolveTenantByHost } from '@/lib/tenant/resolve';
import { getDefaultChannelGroup } from '@/lib/channel-group';

const VERIFICATION_TOKEN_TTL_HOURS = 24;
const VERIFICATION_TOKEN_BYTES = 32;

function hashVerificationToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
}

// bcrypt is a Node-native dep (and prisma adapter-pg too) — pin runtime so
// Next doesn't try to put this on the Edge.
export const runtime = 'nodejs';

const BCRYPT_ROUNDS = 12;

const RegisterSchema = z.object({
    email: z
        .string()
        .email()
        .max(254)
        .transform((s) => s.trim().toLowerCase()),
    password: z.string().min(8).max(128),
    nickname: z.string().trim().max(64).optional(),
    // W7 D4: optional invite code. Empty/whitespace-only strings are
    // collapsed to undefined so the form's "leave blank" path doesn't
    // hit the validity check below.
    invite_code: z
        .string()
        .max(64)
        .optional()
        .transform((s) => {
            if (!s) return undefined;
            const trimmed = s.trim();
            return trimmed.length > 0 ? trimmed : undefined;
        }),
});

/**
 * Best-effort cleanup of any new-api user that may have been created before
 * provisionNewCustomer threw. provisionNewCustomer is a 6-step flow; if step 1
 * (createUser) failed, nothing exists and search returns nothing. If step 2-6
 * failed, the new-api user exists with the deterministic `c-{portal_uuid8}`
 * username and we need to delete it (this also disposes any token created
 * in step 4 since deleteUser is a soft-delete that disables the user record).
 */
async function cleanupOrphanNewApiUser(portalUserId: string, contextEmail: string): Promise<void> {
    const username = `c-${portalUserId.slice(0, 8)}`;
    try {
        const search = await searchNewApiUser(username, 1, 5);
        const orphan = search.items.find((u) => u.username === username);
        if (orphan) {
            await deleteNewApiUser(orphan.id);
            console.warn(
                `[register] cleaned orphan new-api user id=${orphan.id} username=${username} after provision failure for ${contextEmail}`,
            );
        }
    } catch (err) {
        console.error(`[register] orphan new-api cleanup failed for ${contextEmail} (username=${username}):`, err);
    }
}

export async function POST(req: NextRequest) {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = RegisterSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'validation_failed', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { email, password, nickname, invite_code } = parsed.data;

    // P6a: attribute the new customer to the tenant of the request domain
    // (platform domain → platform tenant; partner domain → partner tenant).
    // A tenant can disable self-serve signup → reject early.
    const tenant = await resolveTenantByHost(req.headers.get('host'));
    if (!tenant.signup_enabled) {
        return NextResponse.json(
            { error: 'signup_disabled', message: '该站点暂未开放自助注册,请联系客服。' },
            { status: 403 },
        );
    }

    // PR-U1: polymorphic invite resolution. Try reseller code FIRST,
    // fall back to env allow-list (W7 D4). Both paths gated by a single
    // form field. Resolution outcomes:
    //   none                  — empty input, no attribution
    //   reseller              — set inviter_code_id / inviter_reseller_id /
    //                            attribution_expires_at
    //   env_invite_code       — set User.invite_code = raw string
    //   self_invite_rejected  — return 400 (防控 #1)
    //   invalid               — return 400
    const now = new Date();
    const resolved = await resolveInviteCode({
        typedCode: invite_code,
        registeringEmail: email,
        now,
    });
    if (resolved.kind === 'invalid') {
        return NextResponse.json(
            { error: 'invalid_invite_code', message: '邀请码无效。可清空后继续注册。' },
            { status: 400 },
        );
    }
    if (resolved.kind === 'self_invite_rejected') {
        // 防控 #1 — record audit then 400. Pass new_user=null because the
        // user row isn't created yet; the reseller's own user_id goes in
        // properties so ops can trace which reseller this was about.
        await recordAnalytics({
            userId: null,
            eventType: 'reseller_self_invite_rejected',
            properties: {
                reseller_id: resolved.resellerUserId,
                registering_email_lower: email,
            },
        });
        return NextResponse.json(
            { error: 'invalid_invite_code', message: '不能使用自己的邀请码注册' },
            { status: 400 },
        );
    }

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
        return NextResponse.json({ error: 'email_already_registered' }, { status: 409 });
    }

    let defaultGroup;
    try {
        defaultGroup = await getDefaultChannelGroup(tenant.id);
    } catch (err) {
        console.error(`[register] default channel group unavailable for tenant ${tenant.id}:`, err);
        return NextResponse.json(
            { error: 'default_tier_unavailable', message: 'Account provisioning is temporarily unavailable' },
            { status: 503 },
        );
    }

    const password_hash = await hash(password, BCRYPT_ROUNDS);

    // PR-U1: capture register-time IP + UA on the User row. Both fields are
    // nullable — local dev curl without a proxy header set produces null.
    const signupIp = extractClientIP(req);
    const signupUa = req.headers.get('user-agent')?.slice(0, 500) ?? null;

    let user;
    try {
        user = await prisma.user.create({
            data: {
                email,
                password_hash,
                nickname: nickname || null,
                // P6a: customer belongs to the request-domain's tenant.
                tenant_id: tenant.id,
                // W7 D4 env allow-list path — set raw typed code.
                invite_code: resolved.kind === 'env_invite_code' ? resolved.invite_code : null,
                // PR-U1 reseller attribution path — set FK + expiry.
                inviter_code_id: resolved.kind === 'reseller' ? resolved.inviter_code_id : null,
                inviter_reseller_id: resolved.kind === 'reseller' ? resolved.inviter_reseller_id : null,
                attribution_expires_at: resolved.kind === 'reseller' ? resolved.attribution_expires_at : null,
                signup_ip: signupIp,
                signup_ua: signupUa,
            },
            select: {
                id: true,
                email: true,
                nickname: true,
                email_verified: true,
                locale: true,
                status: true,
                created_at: true,
            },
        });
    } catch (err) {
        // Unique-violation race (someone registered between findUnique and create)
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            return NextResponse.json({ error: 'email_already_registered' }, { status: 409 });
        }
        throw err;
    }

    let provisioned: ProvisionedCustomer;
    try {
        provisioned = await provisionNewCustomer({
            portal_user_id: user.id,
            email: user.email,
            newapi_group: defaultGroup.newapi_group,
            initial_quota: 0,
        });
    } catch (provisionErr) {
        // The 6-step flow failed somewhere. Step 1 failure leaves nothing
        // on new-api; step 2-6 failures leave a half-built user that we
        // must delete to keep the username slot free and ops dashboards clean.
        await cleanupOrphanNewApiUser(user.id, email);
        await prisma.user.delete({ where: { id: user.id } }).catch((deleteErr) => {
            console.error(
                `[register] new-api provision failed AND portal rollback failed for user ${user.id}:`,
                deleteErr,
            );
        });
        console.error(`[register] provisionNewCustomer failed for ${email}:`, provisionErr);
        return NextResponse.json(
            { error: 'provisioning_failed', message: 'Account provisioning failed, please retry' },
            { status: 502 },
        );
    }

    // Persist the new-api linkage on portal side. If this fails, the new-api
    // user + token already exist — we must clean them up too, otherwise next
    // attempt with the same email/portal_user_id collides on
    // newapi_username unique constraint.
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
                    tier: defaultGroup.key,
                },
            }),
        ]);
    } catch (linkageErr) {
        const tokenPreview =
            typeof provisioned.newapi_token_value === 'string'
                ? `${provisioned.newapi_token_value.slice(0, 12)}...`
                : `<${typeof provisioned.newapi_token_value}>`;
        console.error(
            `[register] new-api provision succeeded for ${user.id} ` +
                `(newapi_user_id=${provisioned.newapi_user_id}, ` +
                `token=${tokenPreview}) ` +
                `but persisting linkage failed — rolling back both sides:`,
            linkageErr,
        );
        // Cascade-clean: delete new-api user (soft delete; token disposed),
        // then delete portal user. If either cleanup throws, log loudly so
        // ops can reconcile manually — at least we tried.
        await deleteNewApiUser(provisioned.newapi_user_id).catch((err) =>
            console.error(`[register] new-api user cleanup failed for ${provisioned.newapi_user_id}:`, err),
        );
        await prisma.user
            .delete({ where: { id: user.id } })
            .catch((err) => console.error(`[register] portal user cleanup failed for ${user.id}:`, err));
        return NextResponse.json(
            { error: 'persistence_failed', message: 'Account creation failed, please retry' },
            { status: 500 },
        );
    }

    // PR-T1 Phase 0c — eagerly provision the portal system token used by
    // server-managed services (image gen / future internal flows). Best-
    // effort: failure here is logged but does not block registration; the
    // first call to getOrCreateSystemToken from a portal-managed handler
    // will retry. Idempotent + race-safe (CAS via WHERE … IS NULL).
    try {
        const { getOrCreateSystemToken } = await import('@/lib/newapi/system-token');
        await getOrCreateSystemToken(user.id);
    } catch (sysTokErr) {
        console.warn(
            `[register] portal system token eager-provision failed for ${user.id} (will retry lazily on first portal-managed call):`,
            sysTokErr,
        );
    }

    // PR-U1: post-create analytics + 防控 #2 IP throttle check (24h same-IP
    // + same-code ≥3 registrations → flag for ops review). Never blocks
    // registration; record-only. Wrapped in try/catch so a Prisma blip on
    // analytics path can't break a successful registration.
    if (resolved.kind === 'reseller') {
        try {
            await recordAnalytics({
                userId: user.id,
                eventType: 'reseller_attribution_assigned',
                properties: {
                    reseller_id: resolved.inviter_reseller_id,
                    inviter_code_id: resolved.inviter_code_id,
                    attribution_expires_at: resolved.attribution_expires_at.toISOString(),
                    signup_ip: signupIp,
                },
            });
            await checkIpThrottleAndFlag({
                signup_ip: signupIp,
                inviter_code_id: resolved.inviter_code_id,
                inviter_reseller_id: resolved.inviter_reseller_id,
                new_user_id: user.id,
                now,
            });
        } catch (analyticsErr) {
            console.warn(
                `[register] reseller analytics / throttle check failed for ${user.id} (registration succeeded):`,
                analyticsErr,
            );
        }
    }

    // Issue an email-verification token + fire off the verification email.
    // Failures here don't roll back registration — the customer can request a
    // resend from /api/auth/resend-verification. Logged loudly so ops notice.
    try {
        const rawToken = randomBytes(VERIFICATION_TOKEN_BYTES).toString('hex');
        const tokenHash = hashVerificationToken(rawToken);
        const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000);

        await prisma.emailVerificationToken.create({
            data: { user_id: user.id, token_hash: tokenHash, expires_at: expiresAt },
        });

        const verifyUrl = `${getAppUrl()}/verify-email?token=${rawToken}`;

        try {
            await sendVerificationEmail({
                to: user.email,
                verifyUrl,
                expiresInHours: VERIFICATION_TOKEN_TTL_HOURS,
            });
        } catch (mailErr) {
            console.warn(
                `[register] verification mail send failed for ${user.email} (token row stays valid):`,
                mailErr,
            );
        }
    } catch (tokenErr) {
        console.error(
            `[register] verification token creation failed for ${user.id} — user is registered but won't get verify email until they hit /resend-verification:`,
            tokenErr,
        );
    }

    const token = await signSession(user.id);

    const res = NextResponse.json({
        user_id: user.id,
        token,
        newapi_user_id: provisioned.newapi_user_id,
        newapi_token_value: provisioned.newapi_token_value,
        portal_user: {
            id: user.id,
            email: user.email,
            nickname: user.nickname,
            email_verified: user.email_verified,
            locale: user.locale,
            status: user.status,
            created_at: user.created_at,
        },
    });
    setSessionCookie(res, token, req);
    return res;
}

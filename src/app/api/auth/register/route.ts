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
    email: z.string().email().max(254).transform((s) => s.trim().toLowerCase()),
    password: z.string().min(8).max(128),
    nickname: z.string().trim().max(64).optional(),
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
        console.error(
            `[register] orphan new-api cleanup failed for ${contextEmail} (username=${username}):`,
            err,
        );
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
    const { email, password, nickname } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
        return NextResponse.json({ error: 'email_already_registered' }, { status: 409 });
    }

    const password_hash = await hash(password, BCRYPT_ROUNDS);

    let user;
    try {
        user = await prisma.user.create({
            data: { email, password_hash, nickname: nickname || null },
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
                },
            }),
        ]);
    } catch (linkageErr) {
        const tokenPreview = typeof provisioned.newapi_token_value === 'string'
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
        await prisma.user.delete({ where: { id: user.id } }).catch((err) =>
            console.error(`[register] portal user cleanup failed for ${user.id}:`, err),
        );
        return NextResponse.json(
            { error: 'persistence_failed', message: 'Account creation failed, please retry' },
            { status: 500 },
        );
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

        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3002';
        const verifyUrl = `${appUrl}/verify-email?token=${rawToken}`;

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
    setSessionCookie(res, token);
    return res;
}

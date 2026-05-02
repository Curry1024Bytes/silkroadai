import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { hash } from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { provisionNewCustomer } from '@/lib/litellm/client';
import { signSession, setSessionCookie } from '@/lib/auth/session';

// bcrypt is a Node-native dep (and prisma adapter-pg too) — pin runtime so
// Next doesn't try to put this on the Edge.
export const runtime = 'nodejs';

const BCRYPT_ROUNDS = 12;

const RegisterSchema = z.object({
    email: z.string().email().max(254).transform((s) => s.trim().toLowerCase()),
    password: z.string().min(8).max(128),
    nickname: z.string().trim().max(64).optional(),
});

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
        // unique-violation race (someone registered between findUnique and create)
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            return NextResponse.json({ error: 'email_already_registered' }, { status: 409 });
        }
        throw err;
    }

    let provisioned;
    try {
        provisioned = await provisionNewCustomer({
            portal_user_id: user.id,
            email: user.email,
            initial_max_budget: 0,
        });
    } catch (err) {
        // LiteLLM down or rejected — roll back portal user so the account can
        // be re-attempted with the same email.
        await prisma.user.delete({ where: { id: user.id } }).catch((deleteErr) => {
            console.error(
                `[register] LiteLLM provision failed AND portal rollback failed for user ${user.id}:`,
                deleteErr,
            );
        });
        console.error(`[register] LiteLLM provisionNewCustomer failed for ${email}:`, err);
        return NextResponse.json(
            { error: 'provisioning_failed', message: 'Account provisioning failed, please retry' },
            { status: 502 },
        );
    }

    // Persist the LiteLLM linkage. If either of these fails the portal user
    // exists without a key — orphan-cleanup is a W2 task. Logged loudly so
    // ops can spot it.
    try {
        await prisma.$transaction([
            prisma.user.update({
                where: { id: user.id },
                data: { litellm_user_id: provisioned.litellm_user_id },
            }),
            prisma.liteLLMKey.create({
                data: {
                    user_id: user.id,
                    litellm_key: provisioned.litellm_key,
                    key_alias: provisioned.key_alias,
                    max_budget: 0,
                    cached_spend: 0,
                },
            }),
        ]);
    } catch (err) {
        console.error(
            `[register] LiteLLM provisioning succeeded for ${user.id} (key=${provisioned.litellm_key.slice(0, 12)}...) but persisting linkage failed — manual reconciliation needed:`,
            err,
        );
        return NextResponse.json(
            { error: 'persistence_failed', message: 'Account created but key linkage failed, contact support' },
            { status: 500 },
        );
    }

    const token = await signSession(user.id);

    const res = NextResponse.json({
        user_id: user.id,
        token,
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

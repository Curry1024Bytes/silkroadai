import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createHash } from 'crypto';
import { prisma } from '@/lib/db';

// prisma adapter-pg is Node-native; pin runtime so Next doesn't try to put
// this on the Edge.
export const runtime = 'nodejs';

const TOKEN_HEX_LENGTH = 64;

const VerifyEmailSchema = z.object({
    token: z.string().regex(/^[a-f0-9]{64}$/, `token must be ${TOKEN_HEX_LENGTH}-char hex`),
});

function hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
}

export async function POST(req: NextRequest) {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }

    const parsed = VerifyEmailSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { token } = parsed.data;

    const tokenHash = hashToken(token);
    const tokenRow = await prisma.emailVerificationToken.findUnique({
        where: { token_hash: tokenHash },
        select: { id: true, user_id: true, used_at: true, expires_at: true },
    });

    // Single error shape for all token-validation failures so attackers can't
    // distinguish "wrong token" from "expired" from "already used".
    if (!tokenRow || tokenRow.used_at !== null || tokenRow.expires_at <= new Date()) {
        return NextResponse.json({ error: 'invalid_or_expired_token' }, { status: 400 });
    }

    // Atomic: flip user verified flags + mark token used. Both writes go in
    // the same transaction so a partial state can't strand a token row as
    // "used" without the user actually being verified, or vice versa.
    const now = new Date();
    await prisma.$transaction([
        prisma.user.update({
            where: { id: tokenRow.user_id },
            data: {
                email_verified: true,
                email_verified_at: now,
            },
        }),
        prisma.emailVerificationToken.update({
            where: { id: tokenRow.id },
            data: { used_at: now },
        }),
    ]);

    return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { hash } from 'bcryptjs';
import { createHash } from 'crypto';
import { prisma } from '@/lib/db';

// bcryptjs + prisma adapter-pg are Node-native; pin runtime so Next doesn't
// try to put this on the Edge.
export const runtime = 'nodejs';

const BCRYPT_ROUNDS = 10;
const TOKEN_HEX_LENGTH = 64;

const ResetPasswordSchema = z.object({
    token: z.string().regex(/^[a-f0-9]{64}$/, `token must be ${TOKEN_HEX_LENGTH}-char hex`),
    newPassword: z.string().min(8).max(128),
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

    const parsed = ResetPasswordSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { token, newPassword } = parsed.data;

    const tokenHash = hashToken(token);
    const tokenRow = await prisma.passwordResetToken.findUnique({
        where: { token_hash: tokenHash },
        select: { id: true, user_id: true, used_at: true, expires_at: true },
    });

    // Single error shape for all token-validation failures so attackers can't
    // distinguish "wrong token" from "expired token" from "already used".
    if (!tokenRow || tokenRow.used_at !== null || tokenRow.expires_at <= new Date()) {
        return NextResponse.json({ error: 'invalid_or_expired_token' }, { status: 400 });
    }

    const newHash = await hash(newPassword, BCRYPT_ROUNDS);

    // Atomic: rehash, bump session_token_version (kicks all existing JWTs),
    // mark token used. If any step fails, none commit.
    await prisma.$transaction([
        prisma.user.update({
            where: { id: tokenRow.user_id },
            data: {
                password_hash: newHash,
                session_token_version: { increment: 1 },
            },
        }),
        prisma.passwordResetToken.update({
            where: { id: tokenRow.id },
            data: { used_at: new Date() },
        }),
    ]);

    // Don't auto-login; the UI flow is "reset → redirect to /login".
    return NextResponse.json({ ok: true });
}

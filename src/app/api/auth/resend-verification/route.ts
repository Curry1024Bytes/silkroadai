import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomBytes, createHash } from 'crypto';
import { prisma } from '@/lib/db';
import { sendVerificationEmail } from '@/lib/email/send';
import { getAppUrl } from '@/lib/url/app-url';

// nodemailer + prisma adapter-pg are Node-native; pin runtime so Next doesn't
// try to put this on the Edge.
export const runtime = 'nodejs';

const TOKEN_TTL_HOURS = 24;
const THROTTLE_WINDOW_MINUTES = 5;
const TOKEN_BYTES = 32;

const ResendVerificationSchema = z.object({
    email: z.string().email().max(255).transform((s) => s.trim().toLowerCase()),
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

    const parsed = ResendVerificationSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { email } = parsed.data;

    const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, email_verified_at: true, status: true },
    });

    // Quietly noop for: missing user, already-verified user, banned/disabled
    // user. Outward response is always 200 — same shape as forgot-password,
    // for the same no-existence-leak reason.
    if (
        user &&
        user.status === 'active' &&
        user.email_verified_at === null
    ) {
        // 5min throttle: if there's a still-valid unused token issued recently,
        // don't issue a new one and don't send a new email.
        const throttleSince = new Date(Date.now() - THROTTLE_WINDOW_MINUTES * 60 * 1000);
        const recent = await prisma.emailVerificationToken.findFirst({
            where: {
                user_id: user.id,
                used_at: null,
                expires_at: { gt: new Date() },
                created_at: { gt: throttleSince },
            },
            select: { id: true },
        });

        if (!recent) {
            const rawToken = randomBytes(TOKEN_BYTES).toString('hex');
            const tokenHash = hashToken(rawToken);
            const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000);

            try {
                await prisma.emailVerificationToken.create({
                    data: {
                        user_id: user.id,
                        token_hash: tokenHash,
                        expires_at: expiresAt,
                    },
                });

                const verifyUrl = `${getAppUrl()}/verify-email?token=${rawToken}`;

                try {
                    await sendVerificationEmail({
                        to: user.email,
                        verifyUrl,
                        expiresInHours: TOKEN_TTL_HOURS,
                    });
                } catch (mailErr) {
                    console.warn(
                        `[resend-verification] mail send failed for ${user.email} (token row stays valid):`,
                        mailErr,
                    );
                }
            } catch (dbErr) {
                console.error(`[resend-verification] DB write failed for ${user.email}:`, dbErr);
            }
        }
    }

    return NextResponse.json({ ok: true });
}

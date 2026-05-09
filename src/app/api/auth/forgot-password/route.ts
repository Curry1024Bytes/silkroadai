import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomBytes, createHash } from 'crypto';
import { prisma } from '@/lib/db';
import { sendPasswordResetEmail } from '@/lib/email/send';
import { getAppUrl } from '@/lib/url/app-url';

// nodemailer + prisma adapter-pg are Node-native; pin runtime so Next doesn't
// try to put this on the Edge.
export const runtime = 'nodejs';

const TOKEN_TTL_MINUTES = 60;
const THROTTLE_WINDOW_MINUTES = 5;
const TOKEN_BYTES = 32;

const ForgotPasswordSchema = z.object({
    email: z
        .string()
        .email()
        .max(255)
        .transform((s) => s.trim().toLowerCase()),
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

    const parsed = ForgotPasswordSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { email } = parsed.data;

    // Always look up. If not found we don't branch on the result for the
    // outward-facing response (the response is 200 either way) — but we DO
    // branch internally to avoid creating a token / sending mail to a
    // non-existent user. Constant-ish time isn't strictly required because the
    // outer response is identical, but we still avoid leaking via async-only-
    // for-real-users patterns by keeping the work small either way.
    const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, status: true },
    });

    // Don't issue tokens for non-existent users, but also don't reveal it.
    // banned/disabled accounts also don't get reset emails (avoids account
    // recovery as a bypass for status enforcement).
    if (user && user.status === 'active') {
        // Throttle: if there's already an unused, unexpired token issued in the
        // last THROTTLE_WINDOW_MINUTES, silently reuse — don't create a new
        // row, don't send a new email. Outward response is still 200.
        const throttleSince = new Date(Date.now() - THROTTLE_WINDOW_MINUTES * 60 * 1000);
        const recent = await prisma.passwordResetToken.findFirst({
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
            const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

            try {
                await prisma.passwordResetToken.create({
                    data: {
                        user_id: user.id,
                        token_hash: tokenHash,
                        expires_at: expiresAt,
                    },
                });

                const resetUrl = `${getAppUrl()}/reset-password?token=${rawToken}`;

                // Email send failure should not block the response. Logged so
                // ops can spot SMTP outages; returns 200 to the client either
                // way (no existence-leak).
                try {
                    await sendPasswordResetEmail({
                        to: user.email,
                        resetUrl,
                        expiresInMinutes: TOKEN_TTL_MINUTES,
                    });
                } catch (mailErr) {
                    console.warn(
                        `[forgot-password] mail send failed for ${user.email} (token row stays valid for retry):`,
                        mailErr,
                    );
                }
            } catch (dbErr) {
                console.error(`[forgot-password] DB write failed for ${user.email}:`, dbErr);
                // Still return 200 — caller doesn't need to distinguish DB
                // outage from "user doesn't exist".
            }
        }
    }

    return NextResponse.json({ ok: true });
}

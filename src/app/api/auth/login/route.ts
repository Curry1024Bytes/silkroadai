import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { compare } from 'bcryptjs';
import { prisma } from '@/lib/db';
import { signSession, setSessionCookie } from '@/lib/auth/session';
import { extractClientIP } from '@/lib/auth/extract-ip';

// bcryptjs + prisma adapter-pg are Node-native; pin runtime so Next doesn't
// try to put this on the Edge.
export const runtime = 'nodejs';

// Real-shape bcrypt hash that always rejects. Used as a fallback target when
// the requested email doesn't exist, so an attacker can't tell users apart by
// timing the response. Format must be valid for bcryptjs.compare not to throw;
// the hash itself is unreachable (it's the bcrypt of a 32-byte random string
// generated once and discarded). Hashes a never-equal-to-anything sentinel.
const TIMING_DEFENSE_HASH = '$2a$12$abcdefghijklmnopqrstuOAk1FzbS9Vct.pRNW8a3VG9JaMvOaJfa';

const LoginSchema = z.object({
    email: z
        .string()
        .email()
        .max(254)
        .transform((s) => s.trim().toLowerCase()),
    password: z.string().min(1).max(128),
});

export async function POST(req: NextRequest) {
    try {
        return await handleLogin(req);
    } catch (err) {
        // W5 D4: zod / 401 paths return early WITHOUT throwing — they don't
        // reach here. Anything that throws is genuinely unexpected (DB
        // outage, bcrypt crash, etc) — Sentry it then re-throw so Next.js
        // returns its standard 500. We don't return a custom error body
        // because we don't want to leak internal details.
        Sentry.captureException(err, { tags: { area: 'login' } });
        throw err;
    }
}

async function handleLogin(req: NextRequest) {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }

    const parsed = LoginSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({
        where: { email },
        include: {
            keys: {
                where: { status: 'active' },
                orderBy: { created_at: 'asc' },
                take: 1,
            },
        },
    });

    // Always run bcrypt.compare even when the user doesn't exist, so timing
    // doesn't leak existence. The fallback hash is unreachable.
    const hashToCheck = user?.password_hash ?? TIMING_DEFENSE_HASH;
    const ok = await compare(password, hashToCheck);

    if (!user || !ok) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    // Refusing logins for disabled / banned accounts (still 401, no leak).
    if (user.status !== 'active') {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    // Best-effort last_login_at + last_login_ip touch (W5 D4: ip captured
    // from x-forwarded-for / x-real-ip set by host Caddy). Fire-and-forget
    // — failure here doesn't block the login response.
    const ip = extractClientIP(req);
    prisma.user
        .update({
            where: { id: user.id },
            data: { last_login_at: new Date(), last_login_ip: ip },
        })
        .catch((err) => {
            console.warn(`[login] last_login_at/ip update failed for ${user.id}:`, err);
        });

    const sessionToken = await signSession(user.id);
    const apiKey = user.keys[0]?.newapi_token_value ?? null;

    const res = NextResponse.json({
        user: {
            id: user.id,
            email: user.email,
            nickname: user.nickname,
            email_verified: user.email_verified,
            locale: user.locale,
            status: user.status,
            newapi_user_id: user.newapi_user_id,
            newapi_username: user.newapi_username,
        },
        apiKey,
    });
    setSessionCookie(res, sessionToken, req);
    return res;
}

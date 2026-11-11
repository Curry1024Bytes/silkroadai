/**
 * Auth attempt log + brute-force throttle (2026-11-11).
 *
 * Every password-login / register / forgot-password / reset-password call
 * writes one `auth_attempts` row. The same rows are the counting source for
 * the throttle, so there is no separate counter to drift, the state is shared
 * by every portal instance, and it survives restarts.
 *
 * Scope — deliberately auth endpoints only. Operator policy is that customer
 * model-API traffic (/v1/*, chat, image, video) is never throttled; nothing
 * here may be wired into those paths.
 *
 * Limits (sliding window):
 *   login            10 failures / 15 min per email   — guessing one account
 *                    30 failures / 15 min per IP      — stuffing many accounts
 *   register         20 requests / 60 min per IP      — bulk signup, and the
 *                                                       409 email-exists oracle
 *   forgot_password  10 requests / 60 min per IP      — mail bombing across
 *                                                       many addresses (the
 *                                                       per-address 5-min token
 *                                                       reuse already exists)
 *
 * Design choices worth knowing before changing this:
 *   - Login counts FAILURES only, so a customer who logs in successfully all
 *     day is never limited.
 *   - The per-email counter restarts after a successful login or a completed
 *     password reset on that email. A customer locked out by someone else's
 *     guessing regains access immediately through the reset mail; nobody
 *     without the mailbox can trigger that.
 *   - The per-IP counter never restarts — otherwise an attacker holding one
 *     valid account could interleave successes to wipe it.
 *   - Per-IP rules are skipped when the address is missing or non-public
 *     (dev, container-internal calls). Limiting on such a value would lump
 *     unrelated callers together.
 *   - Requests rejected with 429 are NOT logged as rows: they must not extend
 *     the lock, and a hammering client must not be able to grow the table.
 *   - Fail open. If the count query errors, the request proceeds — a DB blip
 *     must not take login down.
 *   - `AUTH_RATE_LIMIT_DISABLED=true` turns the throttle off without a deploy
 *     (rows are still written).
 */
import 'server-only';
import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { isPublicIP } from './extract-ip';

export type AuthAttemptKind = 'login' | 'register' | 'forgot_password' | 'reset_password';

export type AuthAttemptOutcome =
    | 'success'
    // login failures — these three are what the login rules count
    | 'bad_password'
    | 'unknown_email'
    | 'inactive'
    // register / forgot_password: the request was accepted for processing
    | 'attempt';

interface Rule {
    max: number;
    windowMs: number;
}

const MINUTE = 60_000;

export const AUTH_RATE_LIMITS: Record<
    Exclude<AuthAttemptKind, 'reset_password'>,
    { email?: Rule; ip?: Rule; countedOutcomes?: AuthAttemptOutcome[] }
> = {
    login: {
        email: { max: 10, windowMs: 15 * MINUTE },
        ip: { max: 30, windowMs: 15 * MINUTE },
        countedOutcomes: ['bad_password', 'unknown_email', 'inactive'],
    },
    register: { ip: { max: 20, windowMs: 60 * MINUTE } },
    forgot_password: { ip: { max: 10, windowMs: 60 * MINUTE } },
};

/** Rows older than this are pruned opportunistically. */
const RETENTION_MS = 180 * 24 * 60 * MINUTE;
const PRUNE_PROBABILITY = 0.01;

export type RateLimitVerdict = { limited: false } | { limited: true; scope: 'email' | 'ip'; retryAfterSeconds: number };

const OPEN: RateLimitVerdict = { limited: false };

/** created_at of the `n`-th most recent row matching `where`, or null when
 *  fewer than `n` rows match. One indexed query answers both "is the limit
 *  reached" and "when does the oldest counted row leave the window". */
async function nthMostRecent(where: Prisma.AuthAttemptWhereInput, n: number): Promise<Date | null> {
    const row = await prisma.authAttempt.findFirst({
        where,
        orderBy: { created_at: 'desc' },
        skip: n - 1,
        select: { created_at: true },
    });
    return row?.created_at ?? null;
}

function toVerdict(scope: 'email' | 'ip', nth: Date, rule: Rule, now: Date): RateLimitVerdict {
    const ms = nth.getTime() + rule.windowMs - now.getTime();
    return { limited: true, scope, retryAfterSeconds: Math.max(1, Math.ceil(ms / 1000)) };
}

async function checkEmailRule(
    kind: AuthAttemptKind,
    email: string,
    rule: Rule,
    outcomeFilter: Prisma.AuthAttemptWhereInput,
    now: Date,
): Promise<RateLimitVerdict> {
    const windowStart = new Date(now.getTime() - rule.windowMs);
    const base: Prisma.AuthAttemptWhereInput = { kind, email, ...outcomeFilter };

    let nth = await nthMostRecent({ ...base, created_at: { gt: windowStart } }, rule.max);
    if (!nth) return OPEN;

    // Over the raw count. A success / completed reset inside the window
    // restarts the counter from that moment (rare path — two extra queries
    // only once an account is already at the limit).
    const cleared = await prisma.authAttempt.findFirst({
        where: {
            email,
            outcome: 'success',
            kind: { in: ['login', 'reset_password'] },
            created_at: { gt: windowStart },
        },
        orderBy: { created_at: 'desc' },
        select: { created_at: true },
    });
    if (cleared) {
        nth = await nthMostRecent({ ...base, created_at: { gt: cleared.created_at } }, rule.max);
        if (!nth) return OPEN;
    }
    return toVerdict('email', nth, rule, now);
}

async function checkIpRule(
    kind: AuthAttemptKind,
    ip: string,
    rule: Rule,
    outcomeFilter: Prisma.AuthAttemptWhereInput,
    now: Date,
): Promise<RateLimitVerdict> {
    const windowStart = new Date(now.getTime() - rule.windowMs);
    const nth = await nthMostRecent({ kind, ip, ...outcomeFilter, created_at: { gt: windowStart } }, rule.max);
    return nth ? toVerdict('ip', nth, rule, now) : OPEN;
}

/**
 * Decide whether this request may proceed. Call BEFORE doing the expensive
 * work (bcrypt, provisioning, mail). Never throws.
 */
export async function checkAuthRateLimit(
    kind: Exclude<AuthAttemptKind, 'reset_password'>,
    who: { email?: string | null; ip?: string | null },
    now: Date = new Date(),
): Promise<RateLimitVerdict> {
    if (process.env.AUTH_RATE_LIMIT_DISABLED === 'true') return OPEN;
    const rules = AUTH_RATE_LIMITS[kind];
    const outcomeFilter: Prisma.AuthAttemptWhereInput = rules.countedOutcomes
        ? { outcome: { in: rules.countedOutcomes } }
        : {};
    try {
        const checks: Array<Promise<RateLimitVerdict>> = [];
        if (rules.email && who.email) {
            checks.push(checkEmailRule(kind, who.email, rules.email, outcomeFilter, now));
        }
        if (rules.ip && isPublicIP(who.ip)) {
            checks.push(checkIpRule(kind, who.ip, rules.ip, outcomeFilter, now));
        }
        const verdicts = await Promise.all(checks);
        let worst: RateLimitVerdict = OPEN;
        for (const v of verdicts) {
            if (v.limited && (!worst.limited || v.retryAfterSeconds > worst.retryAfterSeconds)) worst = v;
        }
        if (worst.limited) {
            console.warn('[auth-rate-limit] blocked', {
                kind,
                scope: worst.scope,
                email: who.email ?? null,
                ip: who.ip ?? null,
                retryAfterSeconds: worst.retryAfterSeconds,
            });
        }
        return worst;
    } catch (err) {
        console.warn(`[auth-rate-limit] ${kind} check failed — failing open:`, err);
        return OPEN;
    }
}

/**
 * Write one attempt row. Returns its id (for `resolveAuthAttempt`) or null if
 * the write failed — recording is best-effort and never blocks the caller.
 *
 * `created_at` is stamped from the app clock rather than the DB default so
 * the window arithmetic in `checkAuthRateLimit` compares like with like (the
 * portal and its database run on different hosts).
 */
export async function recordAuthAttempt(input: {
    kind: AuthAttemptKind;
    outcome: AuthAttemptOutcome;
    email?: string | null;
    ip?: string | null;
    userId?: string | null;
    userAgent?: string | null;
    now?: Date;
}): Promise<string | null> {
    const now = input.now ?? new Date();
    try {
        const row = await prisma.authAttempt.create({
            data: {
                kind: input.kind,
                outcome: input.outcome,
                email: input.email ? input.email.slice(0, 254) : null,
                ip: input.ip ? input.ip.slice(0, 45) : null,
                user_id: input.userId ?? null,
                user_agent: input.userAgent ? input.userAgent.slice(0, 300) : null,
                created_at: now,
            },
            select: { id: true },
        });
        if (Math.random() < PRUNE_PROBABILITY) {
            void prisma.authAttempt
                .deleteMany({ where: { created_at: { lt: new Date(now.getTime() - RETENTION_MS) } } })
                .catch((err: unknown) => console.warn('[auth-attempts] prune failed:', err));
        }
        return row.id;
    } catch (err) {
        console.warn(`[auth-attempts] record failed (${input.kind}/${input.outcome}):`, err);
        return null;
    }
}

/** Set the final outcome on a row written earlier in the same request. */
export async function resolveAuthAttempt(
    id: string | null,
    patch: { outcome: AuthAttemptOutcome; userId?: string | null },
): Promise<void> {
    if (!id) return;
    try {
        await prisma.authAttempt.update({
            where: { id },
            data: { outcome: patch.outcome, ...(patch.userId !== undefined ? { user_id: patch.userId } : {}) },
        });
    } catch (err) {
        console.warn(`[auth-attempts] resolve failed (${id} → ${patch.outcome}):`, err);
    }
}

export function tooManyAttemptsResponse(verdict: Extract<RateLimitVerdict, { limited: true }>): NextResponse {
    return NextResponse.json(
        { error: 'too_many_attempts', retry_after_seconds: verdict.retryAfterSeconds },
        { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } },
    );
}

import { cache } from 'react';
import type { NextRequest, NextResponse } from 'next/server';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/db';
import { signSession as signSessionRaw, verifySession } from './jwt';

export const SESSION_COOKIE_NAME = 'silkroad_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export class UnauthorizedError extends Error {
    constructor(message = 'Unauthorized') {
        super(message);
        this.name = 'UnauthorizedError';
    }
}

/**
 * Inner verify+lookup, keyed by raw cookie value. Wrapped in React.cache()
 * so multiple `getCurrentUser` calls within the same request (e.g. layout +
 * nested page server components) collapse to a single jose verify + DB read.
 *
 * cache() dedups by argument identity. We pass a string (the cookie value)
 * so all callers sharing the same session in one request hit the same memo
 * slot. Each new request gets its own cache (per-render, per the React 19
 * server-component model).
 */
const _resolveUserFromCookie = cache(
    async (cookieValue: string | undefined): Promise<User | null> => {
        if (!cookieValue) return null;

        const payload = await verifySession(cookieValue);
        if (!payload) return null;

        const user = await prisma.user.findUnique({ where: { id: payload.userId } });
        if (!user) return null;
        if (user.session_token_version !== payload.tokenVersion) return null;

        return user;
    },
);

/**
 * Resolve the request's logged-in user.
 *
 * Returns null on:
 *   - no cookie
 *   - JWT signature/issuer/expiry invalid
 *   - JWT payload missing sub / tv
 *   - user no longer exists
 *   - JWT tv doesn't match user.session_token_version (i.e. the user reset
 *     their password / logged out everywhere since this token was issued)
 *
 * W4-2 D7: dedupes within a request via React.cache() — layout + nested
 * page can both call this and we'll only hit the DB once. The cookie-value
 * cache key works because:
 *   1. Layout + page in the same request see identical cookies, so both
 *      lookups hash to the same memo slot (1 DB read).
 *   2. Different users / revoked sessions get different cookie values, so
 *      no cross-talk between requests.
 */
export async function getCurrentUser(req: NextRequest): Promise<User | null> {
    const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
    return _resolveUserFromCookie(token);
}

export async function requireUser(req: NextRequest): Promise<User> {
    const user = await getCurrentUser(req);
    if (!user) throw new UnauthorizedError();
    return user;
}

/**
 * Sign a session JWT for the given user. Performs one DB read to capture the
 * current session_token_version so the JWT can be invalidated later by
 * bumping that column (see W3 D4 forgot-password flow).
 *
 * Throws if the user doesn't exist (callers should never sign a session for
 * a phantom user; if you need a no-op, branch before calling).
 */
export async function signSession(userId: string): Promise<string> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { session_token_version: true },
    });
    if (!user) throw new Error(`signSession: user ${userId} not found`);
    return signSessionRaw(userId, user.session_token_version);
}

export function setSessionCookie(res: NextResponse, token: string): void {
    res.cookies.set({
        name: SESSION_COOKIE_NAME,
        value: token,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_MAX_AGE_SECONDS,
    });
}

export function clearSessionCookie(res: NextResponse): void {
    res.cookies.set({
        name: SESSION_COOKIE_NAME,
        value: '',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
    });
}

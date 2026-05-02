import type { NextRequest, NextResponse } from 'next/server';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/db';
import { signSession, verifySession } from './jwt';

export const SESSION_COOKIE_NAME = 'silkroad_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export class UnauthorizedError extends Error {
    constructor(message = 'Unauthorized') {
        super(message);
        this.name = 'UnauthorizedError';
    }
}

export async function getCurrentUser(req: NextRequest): Promise<User | null> {
    const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!token) return null;

    const userId = await verifySession(token);
    if (!userId) return null;

    return await prisma.user.findUnique({ where: { id: userId } });
}

export async function requireUser(req: NextRequest): Promise<User> {
    const user = await getCurrentUser(req);
    if (!user) throw new UnauthorizedError();
    return user;
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

export { signSession };

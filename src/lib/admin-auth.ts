import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getEnv } from '@/lib/config';
import { resolveLocale } from '@/lib/locale';

export class AdminUnauthorizedError extends Error {
    constructor(message = 'Unauthorized') {
        super(message);
        this.name = 'AdminUnauthorizedError';
    }
}

function timingSafeStringEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

function extractToken(request: NextRequest): string | null {
    const xAdmin = request.headers.get('x-admin-token');
    if (xAdmin) return xAdmin.trim();

    const authHeader = request.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7).trim();

    const queryToken = request.nextUrl.searchParams.get('token');
    if (queryToken) {
        console.warn(
            '[DEPRECATED] Admin token via query parameter. Use "X-Admin-Token" header instead.',
        );
        return queryToken;
    }

    return null;
}

export async function isAdmin(request: NextRequest): Promise<boolean> {
    const token = extractToken(request);
    if (!token) return false;

    if (timingSafeStringEqual(token, getEnv().ADMIN_TOKEN)) return true;

    // TODO(W2): also accept session cookie whose user has user.role === 'admin'.
    // Requires `role` column on User model, which is intentionally deferred
    // until R1/R2/R3 product decisions land in W2.

    return false;
}

export async function requireAdmin(request: NextRequest): Promise<void> {
    if (!(await isAdmin(request))) throw new AdminUnauthorizedError();
}

/**
 * @deprecated Use {@link isAdmin} instead. Kept so existing callers across
 * src/app/api/admin/* keep compiling until the W1 D5 sweep replaces them.
 */
export const verifyAdminToken = isAdmin;

export function unauthorizedResponse(request?: NextRequest) {
    const locale = resolveLocale(request?.nextUrl.searchParams.get('lang'));
    return NextResponse.json(
        { error: locale === 'en' ? 'Unauthorized' : '未授权' },
        { status: 401 },
    );
}

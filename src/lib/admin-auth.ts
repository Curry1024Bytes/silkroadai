import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import type { UserRole } from '@prisma/client';
import { getEnv } from '@/lib/config';
import { resolveLocale } from '@/lib/locale';
import { getCurrentUser } from '@/lib/auth/session';
import { roleAtLeast } from './admin/roles';

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
        console.warn('[DEPRECATED] Admin token via query parameter. Use "X-Admin-Token" header instead.');
        return queryToken;
    }

    return null;
}

/**
 * Break-glass check: does the request carry a valid ADMIN_TOKEN
 * (X-Admin-Token / Bearer / ?token=)? This is the superadmin-equivalent
 * backdoor kept for emergencies / scripts. No DB hit; does NOT look at the
 * session cookie. Used by {@link isAdmin} and by `resolveAdmin`
 * (src/lib/admin/auth.ts) as the fallback after a session-role check.
 */
export function isBreakGlassToken(request: NextRequest): boolean {
    const token = extractToken(request);
    if (!token) return false;
    return timingSafeStringEqual(token, getEnv().ADMIN_TOKEN);
}

/** Session cookie belongs to a user with role >= minRole? One DB read via
 *  getCurrentUser (React.cache()'d per request). */
async function hasSessionRole(request: NextRequest, minRole: UserRole): Promise<boolean> {
    const user = await getCurrentUser(request);
    return !!user && roleAtLeast(user.role, minRole);
}

/**
 * Legacy admin gate — now cookie-aware (fulfils the old TODO). Passes if EITHER
 * a break-glass ADMIN_TOKEN is present OR the session user has role >= admin.
 *
 * Used by the admin API routes that don't need the richer AdminPrincipal; the
 * routes that wire tenantScope use `resolveAdmin` / `requireRole` from
 * `@/lib/admin/auth`. Guard order per design §3.1: break-glass token first
 * (cheap, no DB), then the session role.
 */
export async function isAdmin(request: NextRequest): Promise<boolean> {
    if (isBreakGlassToken(request)) return true;
    return hasSessionRole(request, 'admin');
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
    return NextResponse.json({ error: locale === 'en' ? 'Unauthorized' : '未授权' }, { status: 401 });
}

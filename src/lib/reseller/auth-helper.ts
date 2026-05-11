/**
 * Shared auth + reseller-lookup helper for /api/portal/reseller/* (PR-U1).
 *
 * Most endpoints follow the same shape:
 *   1. cookie-auth → user
 *   2. find reseller row for user (auto-IDOR-safe via WHERE user_id = me)
 *   3. either business logic or 404 if not a reseller
 *
 * Centralized so all 9 endpoints behave consistently and the auth path is
 * single-touch — no chance of one endpoint forgetting the cookie check or
 * the reseller-existence check.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import type { Reseller } from '@prisma/client';

export interface AuthedResellerCtx {
    userId: string;
    reseller: Reseller;
}

/**
 * Resolve current user + their reseller row. Returns a NextResponse on
 * any failure (caller short-circuits with `return result.response`).
 *
 *   - no session       → 401 invalid_credentials
 *   - user not joined  → 404 not_a_reseller (caller decides whether to expose)
 *
 * Successful path: `{ ok: true, ctx: { userId, reseller } }`.
 *
 * The discriminated `ok` literal lets TS narrow the union after a
 * single `if (!result.ok) return result.response;` so endpoints don't
 * end up with `NextResponse | null` in their inferred return types.
 */
export async function getAuthedReseller(
    req: NextRequest,
): Promise<{ ok: true; ctx: AuthedResellerCtx } | { ok: false; response: NextResponse }> {
    const user = await getCurrentUser(req);
    if (!user) {
        return {
            ok: false,
            response: NextResponse.json({ error: 'invalid_credentials' }, { status: 401 }),
        };
    }
    const reseller = await prisma.reseller.findUnique({ where: { user_id: user.id } });
    if (!reseller) {
        return {
            ok: false,
            response: NextResponse.json({ error: 'not_a_reseller' }, { status: 404 }),
        };
    }
    return { ok: true, ctx: { userId: user.id, reseller } };
}

/**
 * Resolve current user only — for endpoints (like POST /join) that may
 * not have a reseller row yet.
 *
 * Same discriminated-union pattern as getAuthedReseller for clean TS
 * narrowing at the call site.
 */
export async function getAuthedUserId(
    req: NextRequest,
): Promise<{ ok: true; userId: string } | { ok: false; response: NextResponse }> {
    const user = await getCurrentUser(req);
    if (!user) {
        return {
            ok: false,
            response: NextResponse.json({ error: 'invalid_credentials' }, { status: 401 }),
        };
    }
    return { ok: true, userId: user.id };
}

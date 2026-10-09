/**
 * PATCH  /api/portal/keys/[id] — rename a key (alias only).
 * DELETE /api/portal/keys/[id] — revoke a key.
 *
 * PATCH steps:
 *   1. Auth (cookie session) + zod `{ alias }` (same rule as create: 1-50
 *      chars, `portal-internal*` prefix reserved)
 *   2. Load token row, verify user_id matches session (IDOR → 401)
 *   3. Revoked token → 410 (nothing upstream to rename)
 *   4. new-api renameToken (GET + full PUT, see client.ts) FIRST — if it
 *      throws we leave Prisma untouched so list + new-api stay in sync
 *   5. Prisma `key_alias` update
 *
 * DELETE steps:
 *   1. Auth (cookie session)
 *   2. Load token row, verify user_id matches session (defense against IDOR)
 *   3. Call new-api deleteToken(customerAuth, newapi_token_id) — true revoke
 *      on the upstream side (sk- becomes invalid immediately)
 *   4. Set Prisma `status='disabled'` (NOT hard delete — Order/RechargeLog
 *      have FK refs that default to RESTRICT; soft-delete preserves audit
 *      trail and avoids cascade surprises)
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { deleteToken as newapiDeleteToken, renameToken as newapiRenameToken } from '@/lib/newapi/client';
import { PORTAL_INTERNAL_TOKEN_NAME } from '@/lib/newapi/system-token';

export const runtime = 'nodejs';

/** Same alias rule as POST /api/portal/keys (CreateKeySchema.alias). Kept
 *  in sync by hand — the two routes are separate modules and the create
 *  schema also carries `tier`, which rename must not accept. */
const RenameKeySchema = z.object({
    alias: z
        .string()
        .trim()
        .min(1, 'alias must not be empty')
        .max(50, 'alias must be ≤ 50 chars')
        .refine((s) => !s.startsWith(PORTAL_INTERNAL_TOKEN_NAME), {
            message: `alias starting with "${PORTAL_INTERNAL_TOKEN_NAME}" is reserved`,
        }),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(req);
    if (!user) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }
    if (user.newapi_user_id == null || !user.newapi_access_token) {
        console.error(`[portal/keys PATCH] user ${user.id} has no newapi auth; cannot rename`);
        return NextResponse.json({ error: 'account_not_provisioned' }, { status: 500 });
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }
    const parsed = RenameKeySchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'validation_error', details: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const alias = parsed.data.alias;

    const { id } = await params;
    const token = await prisma.newApiToken.findUnique({
        where: { id },
        select: {
            id: true,
            user_id: true,
            newapi_token_id: true,
            status: true,
            key_alias: true,
        },
    });
    if (!token) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    // IDOR defense — same 401 shape as DELETE so existence doesn't leak.
    if (token.user_id !== user.id) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }
    if (token.status !== 'active') {
        return NextResponse.json({ error: 'token_revoked' }, { status: 410 });
    }
    if (token.key_alias === alias) {
        // No-op rename — skip the new-api round-trip.
        return NextResponse.json({ ok: true, key_alias: alias });
    }

    const customerAuth = {
        accessToken: user.newapi_access_token,
        userId: user.newapi_user_id,
    };

    // new-api first (mirrors DELETE ordering): a failure here leaves the
    // portal row untouched so the customer sees the old alias and can
    // retry, instead of a portal/new-api name split.
    try {
        await newapiRenameToken(customerAuth, token.newapi_token_id, alias);
    } catch (newapiErr) {
        console.error(`[portal/keys PATCH] new-api renameToken failed for portal token ${id}:`, newapiErr);
        return NextResponse.json({ error: 'newapi_update_failed' }, { status: 502 });
    }

    await prisma.newApiToken.update({
        where: { id },
        data: { key_alias: alias },
    });

    return NextResponse.json({ ok: true, key_alias: alias });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(req);
    if (!user) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }
    if (user.newapi_user_id == null || !user.newapi_access_token) {
        console.error(`[portal/keys DELETE] user ${user.id} has no newapi auth; cannot revoke`);
        return NextResponse.json({ error: 'account_not_provisioned' }, { status: 500 });
    }

    const { id } = await params;
    const token = await prisma.newApiToken.findUnique({
        where: { id },
        select: {
            id: true,
            user_id: true,
            newapi_token_id: true,
            status: true,
        },
    });
    if (!token) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    // IDOR defense: a user cannot revoke another user's token even by
    // guessing the UUID. Returns 401 (not 403/404) to avoid leaking
    // existence — same shape as the unauth case.
    if (token.user_id !== user.id) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }
    if (token.status !== 'active') {
        // Already revoked — idempotent return so a double-click doesn't
        // confuse the UI.
        return NextResponse.json({ ok: true, already: true });
    }

    const customerAuth = {
        accessToken: user.newapi_access_token,
        userId: user.newapi_user_id,
    };

    // new-api side first — if this throws, we leave Prisma untouched so the
    // user still sees the key (and can retry). If we flipped Prisma first
    // and new-api delete failed, the customer would see the key gone but
    // it'd still work upstream — confusing.
    try {
        await newapiDeleteToken(customerAuth, token.newapi_token_id);
    } catch (newapiErr) {
        console.error(`[portal/keys DELETE] new-api deleteToken failed for portal token ${id}:`, newapiErr);
        return NextResponse.json({ error: 'newapi_delete_failed' }, { status: 502 });
    }

    await prisma.newApiToken.update({
        where: { id },
        data: { status: 'disabled' },
    });

    return NextResponse.json({ ok: true });
}

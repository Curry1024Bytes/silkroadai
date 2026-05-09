/**
 * DELETE /api/portal/keys/[id] — revoke a key.
 *
 * Steps:
 *   1. Auth (cookie session)
 *   2. Load token row, verify user_id matches session (defense against IDOR)
 *   3. Call new-api deleteToken(customerAuth, newapi_token_id) — true revoke
 *      on the upstream side (sk- becomes invalid immediately)
 *   4. Set Prisma `status='disabled'` (NOT hard delete — Order/RechargeLog
 *      have FK refs that default to RESTRICT; soft-delete preserves audit
 *      trail and avoids cascade surprises)
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { deleteToken as newapiDeleteToken } from '@/lib/newapi/client';

export const runtime = 'nodejs';

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

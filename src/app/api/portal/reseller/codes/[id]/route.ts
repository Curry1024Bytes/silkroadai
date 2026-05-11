/**
 * DELETE /api/portal/reseller/codes/[id] (PR-U1)
 *
 * Soft-delete (is_active=false). Hard delete would break FK from User
 * rows whose inviter_code_id points here, plus break commission lookup.
 * Soft-delete just prevents new attribution; existing customers keep
 * earning.
 *
 * IDOR: must verify the code belongs to current user's reseller before
 * the update. Done via WHERE reseller_id = current.reseller_id in the
 * UPDATE — count=0 means either not found or not yours; both surface as
 * 404 (don't reveal existence).
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthedReseller } from '@/lib/reseller/auth-helper';

export const runtime = 'nodejs';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!id || typeof id !== 'string') {
        return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
    }
    const auth = await getAuthedReseller(req);
    if (!auth.ok) return auth.response;
    const { ctx } = auth;

    const result = await prisma.resellerInviteCode.updateMany({
        where: {
            id,
            reseller_id: ctx.reseller.id,
            is_active: true,
        },
        data: { is_active: false },
    });

    if (result.count === 0) {
        // Either code doesn't exist, isn't yours, or is already inactive.
        // 404 keeps IDOR-safe (don't differentiate).
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
}

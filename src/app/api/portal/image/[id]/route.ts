/**
 * GET    /api/portal/image/[id]   — single generation detail
 * DELETE /api/portal/image/[id]   — soft delete (R2 cleanup deferred)
 *
 * (PR-T1 Phase 3b)
 *
 * `user_id` ownership is enforced — cross-user access returns 404
 * rather than 403 to avoid leaking row existence (matches W7 PR-J
 * isolation pattern).
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { getPublicUrl } from '@/lib/r2/client';

export const runtime = 'nodejs';

const IdSchema = z.string().uuid();

interface RouteContext {
    params: Promise<{ id: string }>;
}

async function loadOwned(req: NextRequest, ctx: RouteContext) {
    const user = await getCurrentUser(req);
    if (!user) return { kind: 'unauth' as const };
    const { id } = await ctx.params;
    const parsed = IdSchema.safeParse(id);
    if (!parsed.success) return { kind: 'bad_id' as const };
    const row = await prisma.imageGeneration.findFirst({
        where: { id: parsed.data, user_id: user.id, is_deleted: false },
    });
    if (!row) return { kind: 'not_found' as const };
    return { kind: 'ok' as const, user, row };
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
    const r = await loadOwned(req, ctx);
    if (r.kind === 'unauth') return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    if (r.kind === 'bad_id') return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    if (r.kind === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const row = r.row;
    return NextResponse.json({
        id: row.id,
        prompt: row.prompt,
        model_name: row.model_name,
        size: row.size,
        count: row.count,
        image_urls: (row.r2_keys as string[]).map(getPublicUrl),
        cost_usd: Number(row.cost_usd),
        is_favorite: row.is_favorite,
        created_at: row.created_at.toISOString(),
        expires_at: row.expires_at?.toISOString() ?? null,
    });
}

export async function DELETE(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
    const r = await loadOwned(req, ctx);
    if (r.kind === 'unauth') return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    if (r.kind === 'bad_id') return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    if (r.kind === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 });
    // Soft delete — R2 objects + DB row hard-deleted by cleanup cron
    // 30 days later. Keeps "undo" cheap for the next 30 days.
    await prisma.imageGeneration.update({
        where: { id: r.row.id },
        data: { is_deleted: true },
    });
    return NextResponse.json({ ok: true });
}

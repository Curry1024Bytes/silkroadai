/**
 * PATCH /api/portal/image/[id]/favorite (PR-T1 Phase 3b)
 *
 * Toggle the `is_favorite` flag on a generation. When flipped:
 *   true  → expires_at = null   (永久, cleanup cron skips)
 *   false → expires_at = max(created_at + 30d, now + 30d)
 *           (extra 30d grace from un-favoriting time, mirrors customer
 *            intent "I might still want this for a bit").
 *
 * Returns the post-update {is_favorite, expires_at}.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';

export const runtime = 'nodejs';

const IdSchema = z.string().uuid();
const BodySchema = z.object({
    is_favorite: z.boolean(),
});

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface RouteContext {
    params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
    const user = await getCurrentUser(req);
    if (!user) return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });

    const { id } = await ctx.params;
    const idCheck = IdSchema.safeParse(id);
    if (!idCheck.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 });

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { is_favorite } = parsed.data;

    const existing = await prisma.imageGeneration.findFirst({
        where: { id: idCheck.data, user_id: user.id, is_deleted: false },
    });
    if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const now = new Date();
    let nextExpires: Date | null;
    if (is_favorite) {
        nextExpires = null; // 永久
    } else {
        // Un-favoriting: pick later of (created_at + 30d, now + 30d).
        // The first arm catches "favorited Day 0, un-favorited Day 5" =
        // 25 days remain. The second catches "favorited Day 0, un-
        // favorited Day 200" = full new 30-day window.
        const baseline = new Date(existing.created_at.getTime() + RETENTION_MS);
        const fresh = new Date(now.getTime() + RETENTION_MS);
        nextExpires = baseline > fresh ? baseline : fresh;
    }

    const updated = await prisma.imageGeneration.update({
        where: { id: idCheck.data },
        data: {
            is_favorite,
            expires_at: nextExpires,
        },
        select: { id: true, is_favorite: true, expires_at: true },
    });

    return NextResponse.json({
        id: updated.id,
        is_favorite: updated.is_favorite,
        expires_at: updated.expires_at?.toISOString() ?? null,
    });
}

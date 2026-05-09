/**
 * GET /api/portal/image/list (PR-T1 Phase 3b)
 *
 * Cursor-paginated history of the current user's image generations.
 * Filter by `all` vs `favorite`. Soft-deleted rows excluded.
 *
 * Query params:
 *   ?cursor=<id>      — opaque cursor (the last-seen id from the
 *                       previous page); first page omits.
 *   ?filter=all|favorite (default `all`)
 *   ?limit=20         — clamp 1..50
 *
 * user_id is enforced server-side; cross-user reads return 0 rows
 * (no 401/404 disambiguation — privacy).
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { getPublicUrl } from '@/lib/r2/client';

export const runtime = 'nodejs';

const QuerySchema = z.object({
    cursor: z.string().uuid().optional(),
    filter: z.enum(['all', 'favorite']).default('all'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
    const user = await getCurrentUser(req);
    if (!user) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    const sp = req.nextUrl.searchParams;
    const parsed = QuerySchema.safeParse({
        cursor: sp.get('cursor') ?? undefined,
        filter: sp.get('filter') ?? undefined,
        limit: sp.get('limit') ?? undefined,
    });
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { cursor, filter, limit } = parsed.data;

    // Take limit+1 so we can tell if there's a next page without a
    // separate count query. Order by created_at desc (most recent first).
    const rows = await prisma.imageGeneration.findMany({
        where: {
            user_id: user.id,
            is_deleted: false,
            ...(filter === 'favorite' ? { is_favorite: true } : {}),
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return NextResponse.json({
        items: items.map((r) => ({
            id: r.id,
            prompt: r.prompt,
            model_name: r.model_name,
            size: r.size,
            count: r.count,
            image_urls: (r.r2_keys as string[]).map(getPublicUrl),
            cost_usd: Number(r.cost_usd),
            is_favorite: r.is_favorite,
            created_at: r.created_at.toISOString(),
            expires_at: r.expires_at?.toISOString() ?? null,
        })),
        next_cursor: hasMore ? items[items.length - 1].id : null,
        has_more: hasMore,
    });
}

/**
 * /image — AI image generation studio (PR-T2).
 *
 * Server-rendered shell + a single client-island orchestrator
 * (`<ImageStudio />`). The shell:
 *   1. Re-uses the (authenticated) layout's auth gate.
 *   2. Pre-fetches the most-recent ImageGeneration row for the user
 *      so the empty-state vs has-history decision is done on the
 *      first paint without a SWR round-trip.
 *
 * Most of the page weight (10 image-component files + their state)
 * lives in the client island; the page itself is a thin wrapper.
 */
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { getPublicUrl } from '@/lib/r2/client';
import { ImageStudio } from './image-studio';
import type { ImageGenerationItem } from '@/components/image/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'AI 生图 — LLmRoute' };

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/image', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

export default async function ImagePage() {
    const user = await getSessionUser();
    if (!user) return null; // layout's auth gate redirects; this is just TS narrowing

    const latestRow = await prisma.imageGeneration.findFirst({
        where: { user_id: user.id, is_deleted: false },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });

    const initialLatest: ImageGenerationItem | null = latestRow
        ? {
              id: latestRow.id,
              prompt: latestRow.prompt,
              model_name: latestRow.model_name,
              size: latestRow.size,
              count: latestRow.count,
              image_urls: (latestRow.r2_keys as string[]).map(getPublicUrl),
              cost_usd: Number(latestRow.cost_usd),
              is_favorite: latestRow.is_favorite,
              created_at: latestRow.created_at.toISOString(),
              expires_at: latestRow.expires_at?.toISOString() ?? null,
          }
        : null;

    return (
        <section>
            <h1 className="m-0 mb-2 text-2xl font-semibold text-navy">AI 生图</h1>
            <p className="m-0 mb-6 text-sm text-muted-ink">
                输入描述,选择模型与尺寸,即可生成图像。生成结果保留 30 天,收藏后永久保留。
            </p>
            <ImageStudio initialLatest={initialLatest} />
        </section>
    );
}

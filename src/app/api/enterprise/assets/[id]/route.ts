import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireEnterpriseUser } from '@/lib/enterprise/session';
import { deleteAsset } from '@/lib/enterprise/assets';

export const runtime = 'nodejs';

/**
 * P3 dashboard 素材单条操作(cookie 会话):PATCH 改名/换组,DELETE 删除(R2+行)。
 * IDOR:一律 WHERE (id, user_id),别人的 id → 404。
 */
const patchSchema = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    group_id: z.string().trim().max(60).nullable().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const { id } = await params;

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 });

    if (parsed.data.group_id) {
        const g = await prisma.enterpriseAssetGroup.findFirst({
            where: { id: parsed.data.group_id, user_id: user.id },
            select: { id: true },
        });
        if (!g) return NextResponse.json({ error: 'group_not_found' }, { status: 404 });
    }
    const r = await prisma.enterpriseAsset.updateMany({
        where: { id, user_id: user.id },
        data: {
            ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
            ...(parsed.data.group_id !== undefined ? { group_id: parsed.data.group_id } : {}),
        },
    });
    if (r.count === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const { id } = await params;
    const done = await deleteAsset(user.id, id);
    if (!done) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true });
}

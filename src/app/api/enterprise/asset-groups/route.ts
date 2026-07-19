import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireEnterpriseUser } from '@/lib/enterprise/session';
import { newAssetId } from '@/lib/enterprise/assets';

export const runtime = 'nodejs';

/** P3 dashboard 素材组:POST 创建。列表随 GET /api/enterprise/assets 一并返回。 */
const createSchema = z.object({ name: z.string().trim().min(1).max(100) });

export async function POST(req: NextRequest) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 });

    const g = await prisma.enterpriseAssetGroup.create({
        data: { id: newAssetId('group'), user_id: user.id, name: parsed.data.name },
    });
    return NextResponse.json({ id: g.id, name: g.name });
}

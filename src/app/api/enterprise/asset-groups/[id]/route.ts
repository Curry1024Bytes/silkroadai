import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireEnterpriseUser } from '@/lib/enterprise/session';

export const runtime = 'nodejs';

/** DELETE 素材组:成员解除引用(不删素材)+ 删组。IDOR:WHERE (id, user_id)。 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const { id } = await params;
    const g = await prisma.enterpriseAssetGroup.findFirst({
        where: { id, user_id: user.id },
        select: { id: true },
    });
    if (!g) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    await prisma.$transaction([
        prisma.enterpriseAsset.updateMany({ where: { group_id: g.id }, data: { group_id: null } }),
        prisma.enterpriseAssetGroup.delete({ where: { id: g.id } }),
    ]);
    return NextResponse.json({ ok: true });
}

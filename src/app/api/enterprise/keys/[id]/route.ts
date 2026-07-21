import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireEnterpriseUser } from '@/lib/enterprise/session';

export const runtime = 'nodejs';

/**
 * DELETE /api/enterprise/keys/[id] — 禁用密钥(软禁用,不 hard delete:审计留痕)。
 * IDOR:updateMany WHERE (id, user_id) —— 别人的 key id 打过来影响 0 行 → 404,不泄漏存在性。
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const { id } = await params;
    const r = await prisma.enterpriseKey.updateMany({
        where: { id, user_id: user.id },
        data: { status: 'disabled' },
    });
    if (r.count === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true });
}

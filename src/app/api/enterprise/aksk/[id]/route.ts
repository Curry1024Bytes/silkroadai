import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireEnterpriseUser } from '@/lib/enterprise/session';

export const runtime = 'nodejs';

/** DELETE /api/enterprise/aksk/[id] — 禁用本人 AK/SK(软删,IDOR-safe updateMany)。 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const { id } = await params;
    const r = await prisma.enterpriseAkSk.updateMany({
        where: { id, user_id: user.id },
        data: { status: 'disabled' },
    });
    if (r.count === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true });
}

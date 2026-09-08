import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveEnterpriseAdmin, auditAdminAction } from '@/lib/enterprise/admin-auth';

export const runtime = 'nodejs';

/**
 * DELETE /api/admin/enterprise/admins/[id] — 撤销次级管理员(2026-09-04)。守门:superadmin。
 * 只删 enterprise_admins 行(即刻失去后台访问);User 账号保留(其审计日志按 admin_email
 * 仍可追溯)。幂等:行不存在 → 404。
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveEnterpriseAdmin(request, { superOnly: true });
    if (!admin) return unauthorizedResponse(request);
    const { id } = await params;

    const user = await prisma.user.findUnique({ where: { id }, select: { email: true } });
    const r = await prisma.enterpriseAdmin.deleteMany({ where: { user_id: id } });
    if (r.count === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    auditAdminAction(request, admin, 'admin_revoke', {
        target: user?.email ?? id,
        params: { user_id: id, email: user?.email ?? null },
    });
    return NextResponse.json({ ok: true });
}

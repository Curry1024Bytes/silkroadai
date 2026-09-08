/**
 * 运营后台 · 次级管理员管理(2026-09-04)。superadmin-only。
 * 授予/撤销走 /api/admin/enterprise/admins(操作本身也进审计)。
 */
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { resolveEnterpriseAdminFromCookies } from '@/lib/enterprise/admin-auth';
import { AdminsManager } from './admins-manager';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 管理员管理' };

export default async function EnterpriseAdminAdminsPage() {
    const admin = await resolveEnterpriseAdminFromCookies();
    if (!admin || admin.level !== 'super') redirect('/enterprise-admin');

    const rows = await prisma.enterpriseAdmin.findMany({ orderBy: { created_at: 'asc' } });
    const users = await prisma.user.findMany({
        where: { id: { in: rows.map((r) => r.user_id) } },
        select: { id: true, email: true, status: true, last_login_at: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const admins = rows.map((r) => {
        const u = byId.get(r.user_id);
        return {
            user_id: r.user_id,
            email: u?.email ?? '(账号已删)',
            user_status: u?.status ?? 'unknown',
            last_login_at: u?.last_login_at ? u.last_login_at.toISOString() : null,
            note: r.note ?? '',
            created_at: r.created_at.toISOString(),
        };
    });

    return <AdminsManager initialAdmins={admins} />;
}

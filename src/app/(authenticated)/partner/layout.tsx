/**
 * /partner/* 守门布局：role >= staff AND tenant_id != PLATFORM_TENANT_ID
 * 否则重定向回 /dashboard（普通客户）或 /admin（平台管理员）。
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { roleAtLeast } from '@/lib/admin/roles';

const PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000001';

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/partner', { method: 'GET', headers: { cookie } });
    return getCurrentUser(req);
}

export default async function PartnerLayout({ children }: { children: React.ReactNode }) {
    const user = await getSessionUser();
    if (!user) redirect('/login');
    if (!roleAtLeast(user.role, 'staff')) redirect('/dashboard');
    if (!user.tenant_id || user.tenant_id === PLATFORM_TENANT_ID) redirect('/admin');
    return <>{children}</>;
}

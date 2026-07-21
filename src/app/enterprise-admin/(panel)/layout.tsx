/**
 * 运营后台守门 layout:superadmin session 才能进(login 页在 group 外)。
 * API 层各端点仍各自 resolveAdmin('superadmin') 细门 —— 这里只是页面粗门。
 */
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { roleAtLeast } from '@/lib/admin/roles';
import { AdminLogoutButton } from './logout-button';

export const dynamic = 'force-dynamic';

export default async function EnterpriseAdminLayout({ children }: { children: ReactNode }) {
    const h = await headers();
    const req = new NextRequest('http://internal/enterprise-admin', {
        method: 'GET',
        headers: { cookie: h.get('cookie') || '' },
    });
    const user = await getCurrentUser(req);
    if (!user || !roleAtLeast(user.role, 'superadmin')) redirect('/enterprise-admin/login');

    return (
        <div className="min-h-screen bg-gray-50">
            <header className="border-b border-gray-200 bg-gray-900">
                <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
                    <div>
                        <span className="text-base font-semibold text-white">Seedance 企业端口 · 运营后台</span>
                    </div>
                    <div className="flex items-center gap-3 text-sm text-gray-300">
                        <span>{user.email}</span>
                        <AdminLogoutButton />
                    </div>
                </div>
            </header>
            <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        </div>
    );
}

/**
 * 运营后台登录页(独立于客户端 /enterprise/login)。用 operator 的 superadmin 账号
 * (与主站 admin 同一账号,同库)。已登录且够权限 → 直接进面板。
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { roleAtLeast } from '@/lib/admin/roles';
import { AdminLoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 运营后台登录' };

export default async function EnterpriseAdminLoginPage() {
    const h = await headers();
    const req = new NextRequest('http://internal/enterprise-admin', {
        method: 'GET',
        headers: { cookie: h.get('cookie') || '' },
    });
    const user = await getCurrentUser(req);
    if (user && roleAtLeast(user.role, 'superadmin')) redirect('/enterprise-admin');

    return (
        <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
            <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
                <h1 className="text-lg font-semibold text-gray-900">运营后台</h1>
                <p className="mb-6 mt-1 text-sm text-gray-500">Seedance 企业端口 · 仅限管理员</p>
                {user && !roleAtLeast(user.role, 'superadmin') && (
                    <p className="mb-4 rounded bg-red-50 p-2 text-sm text-red-700">
                        当前账号({user.email})权限不足,请用管理员账号登录。
                    </p>
                )}
                <AdminLoginForm />
            </div>
        </main>
    );
}

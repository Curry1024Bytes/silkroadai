/**
 * 企业门户登录页(P2)。已登录企业客户直接进 /enterprise。
 * 位于 (dash) route group 之外 —— 不受 dashboard layout 守门(否则循环重定向)。
 */
import { redirect } from 'next/navigation';
import { getEnterpriseSessionUser } from '@/lib/enterprise/session';
import { EnterpriseLoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 登录' };

export default async function EnterpriseLoginPage() {
    const user = await getEnterpriseSessionUser();
    if (user) redirect('/enterprise');

    return (
        <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
            <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
                <h1 className="text-lg font-semibold text-gray-900">Seedance 企业端口</h1>
                <p className="mb-6 mt-1 text-sm text-gray-500">大客户专属控制台</p>
                <EnterpriseLoginForm />
            </div>
        </main>
    );
}

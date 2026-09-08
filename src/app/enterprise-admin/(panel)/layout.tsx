/**
 * 运营后台守门 layout(2026-09-04 起两级):superadmin 全权;次级管理员
 * (enterprise_admins 有行,与全局 role 解耦)日常操作全开,但看不到
 * 审计日志 / 管理员管理(导航隐藏 + API superOnly 双门)。
 * API 层各端点仍各自 resolveEnterpriseAdmin 细门 —— 这里只是页面粗门。
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveEnterpriseAdminFromCookies } from '@/lib/enterprise/admin-auth';
import { AdminLogoutButton } from './logout-button';

export const dynamic = 'force-dynamic';

export default async function EnterpriseAdminLayout({ children }: { children: ReactNode }) {
    const admin = await resolveEnterpriseAdminFromCookies();
    if (!admin || !admin.user) redirect('/enterprise-admin/login');
    const isSuper = admin.level === 'super';

    return (
        <div className="min-h-screen bg-gray-50">
            <header className="border-b border-gray-200 bg-gray-900">
                <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-4">
                        <span className="text-base font-semibold text-white">Seedance 企业端口 · 运营后台</span>
                        <nav className="flex items-center gap-3 text-sm text-gray-300">
                            <Link href="/enterprise-admin" className="hover:text-white">
                                客户
                            </Link>
                            <Link href="/enterprise-admin/logs" className="hover:text-white">
                                请求日志
                            </Link>
                            {isSuper && (
                                <Link href="/enterprise-admin/audit" className="hover:text-white">
                                    操作审计
                                </Link>
                            )}
                            {isSuper && (
                                <Link href="/enterprise-admin/admins" className="hover:text-white">
                                    管理员
                                </Link>
                            )}
                        </nav>
                    </div>
                    <div className="flex items-center gap-3 text-sm text-gray-300">
                        {/* 不给次级管理员看到自己的等级标识(operator 要求 2026-09-04);
                            等级差异只体现在导航可见性(监督面入口仅 super),对本人不点破。 */}
                        <span>{admin.user.email}</span>
                        <AdminLogoutButton />
                    </div>
                </div>
            </header>
            <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        </div>
    );
}

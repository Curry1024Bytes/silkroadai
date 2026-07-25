/**
 * 企业门户 dashboard 布局(P2)—— (dash) route group 单点守门:
 * getEnterpriseSessionUser(主站 JWT cookie + enterprise_upstream_keys 判定)null → /enterprise/login。
 * URL 不带 (dash):/enterprise、/enterprise/billing、/enterprise/logs、/enterprise/keys、/enterprise/assets。
 */
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getEnterpriseSessionUser } from '@/lib/enterprise/session';
import { EnterpriseNav } from './nav';
import { LogoutButton } from './logout-button';

export const dynamic = 'force-dynamic';

export default async function EnterpriseDashLayout({ children }: { children: ReactNode }) {
    const user = await getEnterpriseSessionUser();
    if (!user) redirect('/enterprise/login');

    return (
        <div className="min-h-screen bg-paper">
            <header className="border-b border-brand-border bg-surface">
                <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
                    <div>
                        <span className="text-base font-semibold text-ink">Seedance 企业端口</span>
                        <span className="ml-2 text-xs text-minor-ink">大客户控制台</span>
                    </div>
                    <div className="flex items-center gap-3 text-sm text-muted-ink">
                        <span>{user.email}</span>
                        <LogoutButton />
                    </div>
                </div>
                <div className="mx-auto max-w-6xl px-4">
                    <EnterpriseNav />
                </div>
            </header>
            <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        </div>
    );
}

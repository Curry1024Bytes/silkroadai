'use client';

import { useSearchParams, usePathname } from 'next/navigation';
import { Suspense, useState, type ReactNode } from 'react';
import { resolveLocale } from '@/lib/locale';

interface NavItem {
    path: string;
    label: { zh: string; en: string };
    superadminOnly?: boolean;
}

// P6b §0: platform-level management is superadmin-only (the APIs enforce it too).
// Partner admins (role=admin, tenant scoped) only see tenant-scoped views:
// Dashboard + Orders + Customers. superadmin sees everything.
const NAV_ITEMS: NavItem[] = [
    { path: '/admin', label: { zh: '数据概览', en: 'Dashboard' } },
    { path: '/admin/orders', label: { zh: '订单管理', en: 'Orders' } },
    // P6b-2: read-only customer view — visible to ALL admins (partner backend main page).
    { path: '/admin/customers', label: { zh: '客户管理', en: 'Customers' } },
    { path: '/admin/payment-config', label: { zh: '支付配置', en: 'Payment Config' }, superadminOnly: true },
    { path: '/admin/channel-groups', label: { zh: '渠道分组', en: 'Channel Groups' }, superadminOnly: true },
    { path: '/admin/models', label: { zh: '模型管理', en: 'Models' }, superadminOnly: true },
    { path: '/admin/pricing', label: { zh: '定价', en: 'Pricing' }, superadminOnly: true },
    { path: '/admin/billing-shadow', label: { zh: '影子计量', en: 'Shadow Metering' }, superadminOnly: true },
    { path: '/admin/tenants', label: { zh: '租户管理', en: 'Tenants' }, superadminOnly: true },
    { path: '/admin/announcements', label: { zh: '公告管理', en: 'Announcements' }, superadminOnly: true },
    // 数据存储第③步:请求日志查看(全量客户内容,最高敏感)。
    { path: '/admin/request-logs', label: { zh: '请求日志', en: 'Request Logs' }, superadminOnly: true },
];

function AdminShellInner({
    adminEmail,
    adminRole,
    children,
}: {
    adminEmail: string;
    adminRole: string;
    children: ReactNode;
}) {
    const searchParams = useSearchParams();
    const pathname = usePathname();
    const theme = searchParams.get('theme') || 'light';
    const uiMode = searchParams.get('ui_mode') || 'standalone';
    const locale = resolveLocale(searchParams.get('lang'));
    const isDark = theme === 'dark';
    const [loggingOut, setLoggingOut] = useState(false);

    // P1: token 不再走 URL —— 鉴权改为 cookie session(layout 服务端守门 +
    // /api/admin/* 认 cookie role)。buildUrl 只保留 theme / ui_mode / lang 透传。
    const buildUrl = (path: string) => {
        const params = new URLSearchParams();
        params.set('theme', theme);
        params.set('ui_mode', uiMode);
        if (locale !== 'zh') params.set('lang', locale);
        return `${path}?${params.toString()}`;
    };

    const isActive = (navPath: string) => {
        if (navPath === '/admin') return pathname === '/admin' || pathname === '/admin/dashboard';
        return pathname.startsWith(navPath);
    };

    // P6a: hide superadmin-only entries (e.g. 租户管理) from partner/platform admins.
    const navItems = NAV_ITEMS.filter((it) => !it.superadminOnly || adminRole === 'superadmin');

    async function handleLogout() {
        if (loggingOut) return;
        setLoggingOut(true);
        try {
            await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
        } catch {
            // Bounce out regardless of network outcome — cookie may linger but
            // the server rejects it anyway. Mirrors the customer LogoutButton.
        }
        window.location.href = '/admin/login';
    }

    return (
        <div data-theme={theme} className={['min-h-screen', isDark ? 'bg-slate-950' : 'bg-slate-100'].join(' ')}>
            <div className="px-2 pt-2 sm:px-3 sm:pt-3">
                <nav
                    className={[
                        'mb-1 flex flex-wrap items-center gap-1 rounded-xl border p-1',
                        isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-slate-100/90',
                    ].join(' ')}
                >
                    {navItems.map((item) => (
                        <a
                            key={item.path}
                            href={buildUrl(item.path)}
                            className={[
                                'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                                isActive(item.path)
                                    ? isDark
                                        ? 'bg-indigo-500/30 text-indigo-100 ring-1 ring-indigo-300/35'
                                        : 'bg-white text-slate-900 ring-1 ring-slate-300 shadow-sm'
                                    : isDark
                                      ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
                                      : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/70',
                            ].join(' ')}
                        >
                            {item.label[locale]}
                        </a>
                    ))}
                    <div className="ml-auto flex items-center gap-2 pr-1">
                        <span
                            className={[
                                'hidden max-w-[180px] truncate text-xs sm:inline',
                                isDark ? 'text-slate-400' : 'text-slate-500',
                            ].join(' ')}
                            title={adminEmail}
                        >
                            {adminEmail}
                        </span>
                        <button
                            type="button"
                            onClick={handleLogout}
                            disabled={loggingOut}
                            className={[
                                'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60',
                                isDark
                                    ? 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
                                    : 'text-slate-500 hover:bg-slate-200/70 hover:text-slate-700',
                            ].join(' ')}
                        >
                            {loggingOut
                                ? locale === 'en'
                                    ? 'Signing out…'
                                    : '退出中…'
                                : locale === 'en'
                                  ? 'Sign out'
                                  : '退出'}
                        </button>
                    </div>
                </nav>
            </div>
            {children}
        </div>
    );
}

/**
 * Admin console chrome (client). Extracted from the old `/admin/layout.tsx`
 * client component so the route-group layout can be a server-side auth gate.
 * Keeps theme / ui_mode / lang in the URL (token dropped — auth is cookie
 * session now) and adds an identity + logout strip.
 */
export function AdminShell({
    adminEmail,
    adminRole,
    children,
}: {
    adminEmail: string;
    adminRole: string;
    children: ReactNode;
}) {
    return (
        <Suspense>
            <AdminShellInner adminEmail={adminEmail} adminRole={adminRole}>
                {children}
            </AdminShellInner>
        </Suspense>
    );
}

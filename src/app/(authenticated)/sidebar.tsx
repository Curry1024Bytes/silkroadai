'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import {
    BookOpenText,
    Boxes,
    Cpu,
    CreditCard,
    HardDrive,
    KeyRound,
    LayoutDashboard,
    ScrollText,
    UsersRound,
    Wrench,
    X,
} from 'lucide-react';
import { useMessages } from '@/lib/i18n/client';
import { commonMessages } from '@/lib/i18n/messages/common';

type CommonMessages = (typeof commonMessages)['zh'];

interface NavItem {
    href: string;
    label: string;
    icon: LucideIcon;
    muted?: boolean;
    status?: string;
}

interface NavGroup {
    label: string;
    items: NavItem[];
}

/** Labels come from the common message dict (zh / en), built per render in `Sidebar`. */
function workspaceNav(m: CommonMessages): NavItem[] {
    return [
        { href: '/dashboard', label: m.nav.dashboard, icon: LayoutDashboard },
        { href: '/logs', label: m.nav.logs, icon: ScrollText },
        { href: '/keys', label: m.nav.keys, icon: KeyRound },
        { href: '/tools', label: m.nav.tools, icon: Wrench },
    ];
}

function resourceNav(m: CommonMessages): NavItem[] {
    return [
        { href: '/settings/storage', label: m.nav.storage, icon: HardDrive },
        { href: '/workspace/models', label: m.nav.models, icon: Boxes },
        { href: '/workspace/docs', label: m.nav.docs, icon: BookOpenText },
    ];
}

export interface SidebarProps {
    resellerStatus?: 'active' | 'suspended' | 'banned' | null;
    mobileOpen?: boolean;
    onMobileClose?: () => void;
}

function resellerNavLabel(status: SidebarProps['resellerStatus'], m: CommonMessages): string {
    if (status === 'active' || status === 'suspended' || status === 'banned') return m.nav.resellerConsole;
    return m.nav.resellerJoin;
}

function isRouteActive(pathname: string, href: string): boolean {
    if (href === '/dashboard') return pathname === href;
    return pathname === href || pathname.startsWith(`${href}/`);
}

function NavigationPanel({
    groups,
    pathname,
    onNavigate,
    onClose,
    mobile,
}: {
    groups: NavGroup[];
    pathname: string;
    onNavigate?: () => void;
    onClose?: () => void;
    mobile?: boolean;
}) {
    const m = useMessages(commonMessages);
    return (
        <>
            {mobile && (
                <div className="flex h-[60px] items-center justify-between border-b border-portal-line px-5">
                    <span className="font-display text-sm font-semibold text-portal-ink">{m.sidebar.navigation}</span>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={m.sidebar.close}
                        title={m.sidebar.close}
                        className="flex h-11 w-11 items-center justify-center rounded-lg text-portal-muted transition-colors hover:bg-portal-soft hover:text-portal-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/25"
                    >
                        <X size={19} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                </div>
            )}

            <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-6" aria-label={m.nav.sidebarAria}>
                <div className="space-y-7">
                    {groups.map((group) => (
                        <div key={group.label}>
                            <p className="mb-2 px-3 text-xs font-medium text-portal-subtle">{group.label}</p>
                            <ul className="m-0 list-none space-y-1.5 p-0">
                                {group.items.map((item) => {
                                    const active = isRouteActive(pathname, item.href);
                                    const Icon = item.icon;
                                    return (
                                        <li key={item.href}>
                                            <Link
                                                href={item.href}
                                                aria-current={active ? 'page' : undefined}
                                                data-status={item.status}
                                                onClick={onNavigate}
                                                className={[
                                                    'flex h-11 items-center gap-3 rounded-lg border px-3 text-sm no-underline',
                                                    'transition-[background-color,border-color,color,box-shadow] duration-200 ease-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/25',
                                                    active
                                                        ? 'border-portal-line bg-portal-panel font-semibold text-portal-ink shadow-card'
                                                        : item.muted
                                                          ? 'border-transparent text-minor-ink/70 hover:bg-portal-soft hover:text-portal-muted'
                                                          : 'border-transparent text-portal-muted hover:bg-portal-soft hover:text-portal-ink',
                                                ].join(' ')}
                                            >
                                                <Icon
                                                    size={17}
                                                    strokeWidth={active ? 2 : 1.7}
                                                    className={active ? 'text-brand-accent' : 'text-portal-subtle'}
                                                    aria-hidden="true"
                                                />
                                                <span className="truncate">{item.label}</span>
                                            </Link>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    ))}
                </div>
            </nav>

            <div className="border-t border-portal-line p-4">
                <Link
                    href="/pay"
                    onClick={onNavigate}
                    className="flex h-11 items-center justify-center gap-2 rounded-lg bg-brand-accent px-4 text-sm font-semibold text-white no-underline shadow-card transition-colors duration-200 hover:bg-brand-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/30"
                >
                    <CreditCard size={17} strokeWidth={1.8} aria-hidden="true" />
                    {m.sidebar.topUp}
                </Link>
            </div>
        </>
    );
}

export function Sidebar({ resellerStatus = null, mobileOpen = false, onMobileClose }: SidebarProps) {
    const pathname = usePathname();
    const m = useMessages(commonMessages);
    const resellerMuted = resellerStatus === 'suspended' || resellerStatus === 'banned';
    const groups: NavGroup[] = [
        { label: m.sidebar.groupWorkspace, items: workspaceNav(m) },
        { label: m.sidebar.groupResources, items: resourceNav(m) },
        {
            label: m.sidebar.groupMore,
            items: [
                {
                    href: '/reseller',
                    label: resellerNavLabel(resellerStatus, m),
                    icon: UsersRound,
                    muted: resellerMuted,
                    status: resellerStatus ?? 'none',
                },
                { href: '/gpu', label: m.sidebar.gpu, icon: Cpu },
            ],
        },
    ];

    return (
        <>
            <aside className="sticky top-[60px] hidden h-[calc(100dvh-60px)] w-[228px] shrink-0 flex-col border-r border-black/[0.07] bg-portal-canvas md:flex">
                <NavigationPanel groups={groups} pathname={pathname} />
            </aside>

            {mobileOpen && (
                <div className="fixed inset-0 z-50 md:hidden">
                    <button
                        type="button"
                        className="absolute inset-0 bg-black/45"
                        onClick={onMobileClose}
                        aria-label={m.sidebar.close}
                    />
                    <aside
                        id="portal-mobile-navigation"
                        role="dialog"
                        aria-modal="true"
                        aria-label={m.nav.sidebarAria}
                        className="absolute inset-y-0 left-0 flex w-[min(84vw,304px)] flex-col bg-portal-canvas shadow-card-strong"
                    >
                        <NavigationPanel
                            groups={groups}
                            pathname={pathname}
                            onNavigate={onMobileClose}
                            onClose={onMobileClose}
                            mobile
                        />
                    </aside>
                </div>
            )}
        </>
    );
}

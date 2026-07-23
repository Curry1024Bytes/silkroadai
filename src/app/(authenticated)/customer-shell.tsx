'use client';

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { Sidebar, type SidebarProps } from './sidebar';
import { LogoutButton } from './logout-button';

interface CustomerShellProps {
    logo: ReactNode;
    userEmail: string;
    resellerStatus: SidebarProps['resellerStatus'];
    notices: ReactNode;
    brandStyle?: CSSProperties;
    children: ReactNode;
}

export function CustomerShell({ logo, userEmail, resellerStatus, notices, brandStyle, children }: CustomerShellProps) {
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const initial = userEmail.trim().charAt(0).toUpperCase() || 'U';

    useEffect(() => {
        if (!mobileNavOpen) return;

        const previousOverflow = document.body.style.overflow;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setMobileNavOpen(false);
        };

        document.body.style.overflow = 'hidden';
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            document.body.style.overflow = previousOverflow;
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [mobileNavOpen]);

    return (
        <div className="min-h-dvh overflow-x-hidden bg-portal-canvas text-portal-ink" style={brandStyle}>
            <a
                href="#portal-main"
                className="fixed left-4 top-3 z-[70] -translate-y-20 rounded-md bg-portal-ink px-3 py-2 text-sm text-white transition-transform focus:translate-y-0"
            >
                跳到主要内容
            </a>

            <header className="sticky top-0 z-40 h-16 border-b border-portal-line bg-portal-panel">
                <div className="flex h-full items-center">
                    <div className="flex h-full w-auto items-center gap-3 px-4 md:w-[240px] md:border-r md:border-portal-line md:px-5">
                        <button
                            type="button"
                            onClick={() => setMobileNavOpen(true)}
                            aria-label="打开导航"
                            aria-controls="portal-mobile-navigation"
                            aria-expanded={mobileNavOpen}
                            title="打开导航"
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-portal-muted transition-colors hover:bg-portal-active hover:text-portal-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30 md:hidden"
                        >
                            <Menu size={20} strokeWidth={1.8} aria-hidden="true" />
                        </button>
                        <div className="flex min-w-0 items-center">{logo}</div>
                    </div>

                    <div className="hidden min-w-0 flex-1 items-center px-6 md:flex">
                        <span className="text-sm font-medium text-portal-muted">客户控制台</span>
                    </div>

                    <div className="ml-auto flex h-full items-center gap-2 px-3 sm:gap-3 sm:px-5">
                        <div className="hidden min-w-0 items-center gap-2.5 sm:flex">
                            <span
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-portal-active text-xs font-semibold text-portal-ink"
                                aria-hidden="true"
                            >
                                {initial}
                            </span>
                            <span className="max-w-[220px] truncate text-sm text-portal-muted" title={userEmail}>
                                {userEmail}
                            </span>
                        </div>
                        <div className="h-5 w-px bg-portal-line" aria-hidden="true" />
                        <LogoutButton />
                    </div>
                </div>
            </header>

            <div className="flex min-h-[calc(100dvh-4rem)]">
                <Sidebar
                    resellerStatus={resellerStatus}
                    mobileOpen={mobileNavOpen}
                    onMobileClose={() => setMobileNavOpen(false)}
                />
                <main id="portal-main" className="min-w-0 flex-1 px-4 py-5 sm:px-6 sm:py-7 xl:px-8">
                    <div className="mx-auto w-full max-w-[1440px]">
                        {notices}
                        {children}
                    </div>
                </main>
            </div>
        </div>
    );
}

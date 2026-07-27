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

            <header className="sticky top-0 z-40 h-[60px] border-b border-black/[0.08] bg-white/90 backdrop-blur-xl supports-[backdrop-filter]:bg-white/80">
                <div className="flex h-full items-center">
                    <div className="flex h-full w-auto items-center gap-3 px-3 md:w-[228px] md:border-r md:border-black/[0.07] md:px-5">
                        <button
                            type="button"
                            onClick={() => setMobileNavOpen(true)}
                            aria-label="打开导航"
                            aria-controls="portal-mobile-navigation"
                            aria-expanded={mobileNavOpen}
                            title="打开导航"
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-portal-muted transition-colors duration-200 hover:bg-portal-soft hover:text-portal-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/25 md:hidden"
                        >
                            <Menu size={20} strokeWidth={1.8} aria-hidden="true" />
                        </button>
                        <div className="flex min-w-0 items-center">{logo}</div>
                    </div>

                    <div className="hidden min-w-0 flex-1 items-center px-6 md:flex">
                        <span className="font-display text-sm font-semibold text-portal-muted">工作台</span>
                    </div>

                    <div className="ml-auto flex h-full items-center gap-2 px-3 sm:gap-3 sm:px-5">
                        <div className="hidden min-w-0 items-center gap-2.5 sm:flex">
                            <span
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-accent-soft text-xs font-semibold text-brand-accent"
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

            <div className="flex min-h-[calc(100dvh-60px)]">
                <Sidebar
                    resellerStatus={resellerStatus}
                    mobileOpen={mobileNavOpen}
                    onMobileClose={() => setMobileNavOpen(false)}
                />
                <main id="portal-main" className="min-w-0 flex-1 px-4 py-6 sm:px-7 sm:py-8 xl:px-10">
                    <div className="mx-auto w-full max-w-[1320px]">
                        {notices}
                        {children}
                    </div>
                </main>
            </div>
        </div>
    );
}

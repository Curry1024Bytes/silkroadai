'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { UsagePeriod } from './period';

interface Tab {
    key: UsagePeriod;
    label: string;
}

const TABS: Tab[] = [
    { key: '7d', label: '近 7 天' },
    { key: '30d', label: '近 30 天' },
    { key: 'all', label: '全部' },
];

export function PeriodTabs({ active }: { active: UsagePeriod }) {
    const pathname = usePathname();
    return (
        <div
            role="tablist"
            aria-label="时间窗口"
            className="inline-flex h-11 items-center rounded-lg border border-portal-line bg-portal-panel p-1 shadow-card"
        >
            {TABS.map((tab) => {
                const isActive = tab.key === active;
                return (
                    <Link
                        key={tab.key}
                        href={`${pathname}?period=${tab.key}`}
                        role="tab"
                        aria-selected={isActive}
                        className={[
                            'flex h-9 items-center rounded-md px-3 text-xs font-medium no-underline',
                            'transition-colors duration-200 ease-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/25',
                            isActive
                                ? 'bg-brand-accent-soft font-semibold text-brand-accent'
                                : 'text-portal-muted hover:text-portal-ink',
                        ].join(' ')}
                    >
                        {tab.label}
                    </Link>
                );
            })}
        </div>
    );
}

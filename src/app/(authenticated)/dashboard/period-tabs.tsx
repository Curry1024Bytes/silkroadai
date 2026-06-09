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
            className={[
                'inline-flex bg-surface border border-brand-border rounded-lg overflow-hidden',
                'shadow-card',
            ].join(' ')}
        >
            {TABS.map((tab, idx) => {
                const isActive = tab.key === active;
                const isLast = idx === TABS.length - 1;
                return (
                    <Link
                        key={tab.key}
                        href={`${pathname}?period=${tab.key}`}
                        role="tab"
                        aria-selected={isActive}
                        className={[
                            'px-4 py-2 text-sm no-underline transition-colors duration-150 ease-brand',
                            isActive
                                ? 'bg-navy text-paper font-medium'
                                : 'text-muted-ink hover:bg-paper-muted hover:text-navy',
                            isLast ? '' : 'border-r border-brand-border',
                        ].join(' ')}
                    >
                        {tab.label}
                    </Link>
                );
            })}
        </div>
    );
}

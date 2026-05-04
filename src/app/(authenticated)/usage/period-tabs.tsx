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
            style={{
                display: 'inline-flex',
                background: '#fff',
                border: '1px solid #e5e8ee',
                borderRadius: 4,
                overflow: 'hidden',
            }}
        >
            {TABS.map((tab) => {
                const isActive = tab.key === active;
                return (
                    <Link
                        key={tab.key}
                        href={`${pathname}?period=${tab.key}`}
                        role="tab"
                        aria-selected={isActive}
                        style={{
                            padding: '6px 14px',
                            fontSize: 13,
                            color: isActive ? '#fff' : '#5a6478',
                            background: isActive ? '#0a1535' : 'transparent',
                            textDecoration: 'none',
                            borderRight: '1px solid #e5e8ee',
                        }}
                    >
                        {tab.label}
                    </Link>
                );
            })}
        </div>
    );
}

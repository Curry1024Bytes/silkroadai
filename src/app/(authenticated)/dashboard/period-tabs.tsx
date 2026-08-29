'use client';

/**
 * 周期 tabs(P2 2026-08-29:Link 换 useTransition + router.push)。
 *
 * 之前是 <Link href="?period=">,点击后要等服务端把整页(含跨机 new-api
 * 数据)渲染完才有任何视觉变化 —— 客户以为没点上。现在点击立即乐观高亮
 * 目标 tab(带 pulse 提示加载中),startTransition 里 router.push,数据到
 * 了 active prop 跟上、pulse 消失。pending 期间可以再点别的 tab 改目标。
 */
import { useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
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
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [target, setTarget] = useState<UsagePeriod | null>(null);

    // pending 期间显示点击的目标 tab 为选中(乐观);完成后回归 active prop。
    const shown = isPending && target ? target : active;

    const select = (key: UsagePeriod) => {
        if (key === shown) return;
        setTarget(key);
        startTransition(() => {
            router.push(`${pathname}?period=${key}`);
        });
    };

    return (
        <div
            role="tablist"
            aria-label="时间窗口"
            aria-busy={isPending || undefined}
            className={[
                'inline-flex bg-surface border border-brand-border rounded-lg overflow-hidden',
                'shadow-card',
            ].join(' ')}
        >
            {TABS.map((tab, idx) => {
                const isActive = tab.key === shown;
                const isLast = idx === TABS.length - 1;
                return (
                    <button
                        key={tab.key}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        onClick={() => select(tab.key)}
                        className={[
                            'cursor-pointer px-4 py-2 text-sm transition-colors duration-150 ease-brand',
                            isActive
                                ? 'bg-navy text-paper font-medium'
                                : 'text-muted-ink hover:bg-paper-muted hover:text-navy',
                            isActive && isPending ? 'animate-pulse' : '',
                            isLast ? '' : 'border-r border-brand-border',
                        ].join(' ')}
                    >
                        {tab.label}
                    </button>
                );
            })}
        </div>
    );
}

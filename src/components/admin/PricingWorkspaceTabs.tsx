'use client';

import type { KeyboardEvent, ReactNode } from 'react';

export const pricingWorkspaceTabs = ['group', 'model', 'jobs', 'catalog'] as const;
export type PricingWorkspaceTab = (typeof pricingWorkspaceTabs)[number];

export function pricingWorkspaceTabId(tab: PricingWorkspaceTab): string {
    return `pricing-tab-${tab}`;
}

export default function PricingWorkspaceTabs({
    activeTab,
    onChange,
    en,
    isDark,
    jobCount,
    showModelTab = true,
    panels,
}: {
    activeTab: PricingWorkspaceTab;
    onChange: (tab: PricingWorkspaceTab) => void;
    en: boolean;
    isDark: boolean;
    jobCount: number;
    /**
     * The legacy per-model editor remains available to callers that need it,
     * but the normal pricing workflow is intentionally group-first.  Keeping
     * this switch here lets the admin page hide the legacy entry point without
     * removing the component or its API for existing links/tests.
     */
    showModelTab?: boolean;
    panels: Record<PricingWorkspaceTab, ReactNode>;
}) {
    const labels: Record<PricingWorkspaceTab, string> = en
        ? { group: 'Group pricing', model: 'Model pricing', jobs: 'Publication tasks', catalog: 'Prices & history' }
        : { group: '按档次定价', model: '单模型定价', jobs: '发布任务', catalog: '价格与历史' };

    const visibleTabs: PricingWorkspaceTab[] = showModelTab
        ? [...pricingWorkspaceTabs]
        : pricingWorkspaceTabs.filter((tab): tab is Exclude<PricingWorkspaceTab, 'model'> => tab !== 'model');

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: PricingWorkspaceTab) => {
        const index = visibleTabs.indexOf(tab);
        const nextIndex =
            event.key === 'ArrowRight'
                ? (index + 1) % visibleTabs.length
                : event.key === 'ArrowLeft'
                  ? (index + visibleTabs.length - 1) % visibleTabs.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? visibleTabs.length - 1
                      : null;
        if (nextIndex === null) return;
        event.preventDefault();
        const next = visibleTabs[nextIndex];
        onChange(next);
        event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#${pricingWorkspaceTabId(next)}`)?.focus();
    };

    return (
        <>
            <div
                className={`mb-5 overflow-x-auto rounded-xl border p-1 ${isDark ? 'border-slate-700 bg-slate-950/60' : 'border-slate-200 bg-slate-100/80'}`}
            >
                <div
                    role="tablist"
                    aria-label={en ? 'Pricing sections' : '定价功能'}
                    aria-orientation="horizontal"
                    className="flex min-w-max gap-1"
                >
                    {visibleTabs.map((tab) => {
                        const active = tab === activeTab;
                        return (
                            <button
                                key={tab}
                                type="button"
                                role="tab"
                                id={pricingWorkspaceTabId(tab)}
                                aria-controls={`pricing-panel-${tab}`}
                                aria-selected={active}
                                tabIndex={active ? 0 : -1}
                                onClick={() => onChange(tab)}
                                onKeyDown={(event) => handleKeyDown(event, tab)}
                                className={`inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-500 ${
                                    active
                                        ? isDark
                                            ? 'bg-slate-800 text-emerald-300 shadow-sm'
                                            : 'bg-white text-emerald-700 shadow-sm'
                                        : isDark
                                          ? 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'
                                          : 'text-slate-600 hover:bg-white/60 hover:text-slate-900'
                                }`}
                            >
                                {labels[tab]}
                                {tab === 'jobs' && jobCount > 0 && (
                                    <span
                                        aria-label={en ? `${jobCount} recent tasks` : `${jobCount} 个近期任务`}
                                        className={`rounded-full px-1.5 py-0.5 text-[11px] leading-none tabular-nums ${isDark ? 'bg-slate-700 text-slate-200' : 'bg-slate-200 text-slate-600'}`}
                                    >
                                        {jobCount}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>
            {/* Keep visible workbenches mounted so switching sections preserves unsaved edits and previews. */}
            {visibleTabs.map((tab) => (
                <div
                    key={tab}
                    id={`pricing-panel-${tab}`}
                    role="tabpanel"
                    aria-labelledby={pricingWorkspaceTabId(tab)}
                    hidden={activeTab !== tab}
                    tabIndex={0}
                    className="min-w-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-500"
                >
                    {panels[tab]}
                </div>
            ))}
        </>
    );
}

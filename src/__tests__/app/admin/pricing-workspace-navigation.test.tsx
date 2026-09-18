import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the page's real callback wiring without mounting the network-backed workbenches.
const hooks = vi.hoisted(() => ({
    states: [] as unknown[],
    refs: [] as { current: unknown }[],
    stateIndex: 0,
    refIndex: 0,
}));
vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    return {
        ...actual,
        useState: (initial: unknown) => {
            const index = hooks.stateIndex++;
            if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? initial() : initial;
            return [
                hooks.states[index],
                (next: unknown) => {
                    hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next;
                },
            ];
        },
        useRef: (initial: unknown) => {
            const index = hooks.refIndex++;
            return (hooks.refs[index] ??= { current: initial });
        },
        useEffect: () => {},
        useCallback: (callback: unknown) => callback,
        useMemo: (factory: () => unknown) => factory(),
    };
});
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('theme=light') }));

import PricingPage from '@/app/admin/(console)/pricing/page';
import PricingWorkspaceTabs from '@/components/admin/PricingWorkspaceTabs';
import GroupPricingWorkbench from '@/components/admin/GroupPricingWorkbench';
import CostPricingWorkbench from '@/components/admin/CostPricingWorkbench';
import { PricingPublishJobs } from '@/components/admin/PricingPublishJobs';
import type { PricingPublishJob } from '@/lib/admin/pricing-publish-types';

type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function elements(node: ReactNode): Element[] {
    return Children.toArray(node).flatMap((child) => {
        if (!isValidElement(child)) return [];
        const element = child as Element;
        return [element, ...elements(element.props.children)];
    });
}
function renderPage() {
    hooks.stateIndex = 0;
    hooks.refIndex = 0;
    const content = PricingPage().props.children;
    const tree = content.type(content.props);
    return elements(tree).find((element) => element.type === PricingWorkspaceTabs)!.props as unknown as ComponentProps<
        typeof PricingWorkspaceTabs
    >;
}
function workbench<T extends typeof GroupPricingWorkbench | typeof CostPricingWorkbench>(
    workspace: ReturnType<typeof renderPage>,
    component: T,
): ComponentProps<T> {
    const child = elements(component === GroupPricingWorkbench ? workspace.panels.group : workspace.panels.model).find(
        (element) => element.type === component,
    )!;
    return child.props as unknown as ComponentProps<T>;
}
function jobs(workspace: ReturnType<typeof renderPage>) {
    return elements(workspace.panels.jobs).find((element) => element.type === PricingPublishJobs)!
        .props as unknown as ComponentProps<typeof PricingPublishJobs>;
}

const focus = vi.fn();
const scrollIntoView = vi.fn();
const getElementById = vi.fn().mockReturnValue({ focus, scrollIntoView });
const network = vi.fn().mockImplementation(() => new Promise(() => {}));
beforeEach(() => {
    hooks.states = [];
    hooks.refs = [];
    vi.clearAllMocks();
    vi.stubGlobal('window', { requestAnimationFrame: (callback: () => void) => callback() });
    vi.stubGlobal('document', { getElementById });
    vi.stubGlobal('fetch', network);
});
afterEach(() => vi.unstubAllGlobals());

describe('admin pricing workspace navigation', () => {
    it('defaults to group pricing and does not reload pricing data when switching sections', () => {
        let workspace = renderPage();
        expect(workspace.activeTab).toBe('group');
        for (const tab of ['model', 'catalog', 'jobs', 'group'] as const) {
            workspace.onChange(tab);
            workspace = renderPage();
            expect(workspace.activeTab).toBe(tab);
            expect(workbench(workspace, GroupPricingWorkbench).onPublished).toBeDefined();
            expect(workbench(workspace, CostPricingWorkbench).onPublished).toBeDefined();
        }
        expect(network).not.toHaveBeenCalled();
    });

    it.each([GroupPricingWorkbench, CostPricingWorkbench])(
        'shows the submitted job immediately and focuses its tab',
        (component) => {
            const job = { id: 'job-new', status: 'queued', upstream_model: 'model-a' } as PricingPublishJob;
            const workspace = renderPage();
            workbench(workspace, component).onPublished(job);
            const updated = renderPage();
            expect(updated.activeTab).toBe('jobs');
            expect(jobs(updated).jobs).toEqual([job]);
            expect(jobs(updated).error).toBe('');
            expect(getElementById).toHaveBeenCalledWith('pricing-tab-jobs');
            expect(focus).toHaveBeenCalledWith({ preventScroll: true });
            expect(scrollIntoView).toHaveBeenCalledOnce();
            expect(network).toHaveBeenCalledExactlyOnceWith('/api/admin/pricing');
        },
    );

    it('shows the actual rejected-submission message without claiming it was submitted', () => {
        const workspace = renderPage();
        workbench(workspace, GroupPricingWorkbench).onUncertain('预览已过期，请重新预览。');
        const updated = renderPage();
        expect(updated.activeTab).toBe('jobs');
        expect(jobs(updated).error).toBe('预览已过期，请重新预览。');
        expect(jobs(updated).jobs).toEqual([]);
    });

    it('clears a previous uncertainty warning when a later submission returns a durable job', () => {
        let workspace = renderPage();
        workbench(workspace, CostPricingWorkbench).onUncertain();
        workspace = renderPage();
        expect(jobs(workspace).error).toContain('提交结果尚未确认');
        workbench(workspace, CostPricingWorkbench).onPublished({ id: 'verified-submission' } as PricingPublishJob);
        expect(jobs(renderPage()).error).toBe('');
    });
});

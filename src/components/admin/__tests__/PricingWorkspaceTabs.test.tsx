import { Children, isValidElement, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import PricingWorkspaceTabs, { pricingWorkspaceTabs } from '../PricingWorkspaceTabs';

type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function elements(node: ReactNode): Element[] {
    return Children.toArray(node).flatMap((child) => {
        if (!isValidElement(child)) return [];
        const element = child as Element;
        return [element, ...elements(element.props.children)];
    });
}

const panels = {
    group: <input defaultValue="unsaved group quote" />,
    model: <input defaultValue="unsaved model quote" />,
    jobs: <div>Publication results</div>,
    catalog: <div>Price history</div>,
};
const props = { activeTab: 'group' as const, onChange: vi.fn(), en: false, isDark: false, jobCount: 2, panels };

describe('pricing workspace sections', () => {
    it('keeps the same four keyed panel contents mounted, hiding only inactive sections', () => {
        for (const activeTab of pricingWorkspaceTabs) {
            const tree = PricingWorkspaceTabs({ ...props, activeTab });
            const sections = elements(tree).filter((element) => element.props.role === 'tabpanel');
            expect(sections).toHaveLength(4);
            for (const [index, tab] of pricingWorkspaceTabs.entries()) {
                expect(sections[index].key).toContain(tab);
                expect(sections[index].props.children).toBe(panels[tab]);
                expect(sections[index].props.hidden).toBe(tab !== activeTab);
                expect(sections[index].props['aria-labelledby']).toBe(`pricing-tab-${tab}`);
            }
            const buttons = elements(tree).filter((element) => element.props.role === 'tab');
            expect(buttons.filter((button) => button.props.tabIndex === 0)).toHaveLength(1);
            expect(buttons.find((button) => button.props.tabIndex === 0)?.props.id).toBe(`pricing-tab-${activeTab}`);
        }
    });

    it.each([
        ['group', 'ArrowLeft', 'catalog'],
        ['catalog', 'ArrowRight', 'group'],
        ['group', 'ArrowRight', 'model'],
        ['model', 'End', 'catalog'],
        ['catalog', 'Home', 'group'],
    ] as const)('moves selection and keyboard focus from %s with %s to %s', (tab, key, expected) => {
        const onChange = vi.fn();
        const focus = vi.fn();
        const preventDefault = vi.fn();
        const querySelector = vi.fn().mockReturnValue({ focus });
        const button = elements(PricingWorkspaceTabs({ ...props, activeTab: tab, onChange })).find(
            (element) => element.props.id === `pricing-tab-${tab}`,
        )!;
        const onKeyDown = button.props.onKeyDown as (event: KeyboardEvent<HTMLButtonElement>) => void;
        onKeyDown({
            key,
            preventDefault,
            currentTarget: { parentElement: { querySelector } },
        } as unknown as KeyboardEvent<HTMLButtonElement>);
        expect(onChange).toHaveBeenCalledExactlyOnceWith(expected);
        expect(querySelector).toHaveBeenCalledExactlyOnceWith(`#pricing-tab-${expected}`);
        expect(focus).toHaveBeenCalledOnce();
        expect(preventDefault).toHaveBeenCalledOnce();
    });

    it('leaves Tab navigation native and switches only on an explicit tab click', () => {
        const onChange = vi.fn();
        const preventDefault = vi.fn();
        const button = elements(PricingWorkspaceTabs({ ...props, onChange })).find(
            (element) => element.props.id === 'pricing-tab-jobs',
        )!;
        (button.props.onKeyDown as (event: unknown) => void)({ key: 'Tab', preventDefault });
        expect(preventDefault).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
        (button.props.onClick as () => void)();
        expect(onChange).toHaveBeenCalledExactlyOnceWith('jobs');
    });

    it.each([false, true])('links localized tab labels and panels in dark=%s without hiding the tab row', (isDark) => {
        for (const en of [false, true]) {
            const html = renderToStaticMarkup(<PricingWorkspaceTabs {...props} en={en} isDark={isDark} />);
            expect(html).toContain('role="tablist"');
            expect(html).toContain('aria-orientation="horizontal"');
            expect(html).toContain('overflow-x-auto');
            expect(html).toContain(en ? 'Prices &amp; history' : '价格与历史');
            expect(html).toContain(en ? '2 recent tasks' : '2 个近期任务');
            expect(html.match(/ hidden=""/g)).toHaveLength(3);
            expect(html).toContain('unsaved group quote');
            expect(html).toContain('unsaved model quote');
        }
    });
});

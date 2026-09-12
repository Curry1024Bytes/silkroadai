import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

// /admin/models + /admin/pricing are 'use client' pages using next/navigation
// hooks; mock them so renderToString produces the initial (loading) markup
// under node. They sit behind the (console) server auth gate (covered by the
// P1 console-layout test) — this is a pure render smoke.
vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/admin/models',
}));

import ModelsPage from '@/app/admin/(console)/models/page';
import PricingPage from '@/app/admin/(console)/pricing/page';
import PricingCalculatorPage from '@/app/admin/(console)/pricing-calculator/page';
import ChannelGroupsPage from '@/app/admin/(console)/channel-groups/page';

const PAGES = [
    ['/admin/models', ModelsPage],
    ['/admin/pricing', PricingPage],
    ['/admin/pricing-calculator', PricingCalculatorPage],
] as const;

describe('admin catalog pages — SSR smoke (P2)', () => {
    it.each(PAGES)('%s renders without crashing', (_label, Page) => {
        const html = renderToString(<Page />);
        expect(html.length).toBeGreaterThan(0);
    });

    it('renders an enabled reset control for the pricing calculator', () => {
        const html = renderToString(<PricingCalculatorPage />);
        expect(html).toContain('data-testid="pricing-calculator-reset"');
        expect(html).toMatch(/<button[^>]*type="button"[^>]*data-testid="pricing-calculator-reset"/);
        expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="pricing-calculator-reset"/);
    });

    it('keeps the operator view in Chinese and avoids misleading summed-token copy', () => {
        const html = renderToString(<PricingCalculatorPage />);
        expect(html).toContain('成本 = 官方价格');
        expect(html).toContain('这条请求预计扣费');
        expect(html).toContain('高级：new-api 核对值');
        expect(html).not.toContain('per 1M token categories total');
    });

    it('labels both catalog update entry points with the direction from new-api', () => {
        const network = vi.fn().mockRejectedValue(new Error('SSR network is sealed'));
        vi.stubGlobal('fetch', network);
        try {
            for (const Page of [ModelsPage, ChannelGroupsPage]) {
                const html = renderToString(<Page />);
                expect(html).toContain('从 new-api 更新目录');
                expect(html).not.toContain('>同步 new-api<');
            }
            expect(network).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('distinguishes recorded catalog prices from publication verification', () => {
        const network = vi.fn().mockRejectedValue(new Error('SSR network is sealed'));
        vi.stubGlobal('fetch', network);
        try {
            const html = renderToString(<PricingPage />);
            expect(html).toContain('目录价格与历史');
            expect(html).toContain('下方展示 Portal 已记录的目录价格');
            expect(html).toContain('与 new-api 的核验结果见上方发布任务');
            expect(html).toContain('价格发布任务');
            expect(html).toContain('只有「已生效」表示两端已完成核验');
            expect(network).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

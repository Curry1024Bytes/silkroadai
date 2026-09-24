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
import ChannelGroupsPage from '@/app/admin/(console)/channel-groups/page';

const PAGES = [
    ['/admin/models', ModelsPage],
    ['/admin/pricing', PricingPage],
] as const;

describe('admin catalog pages — SSR smoke (P2)', () => {
    it.each(PAGES)('%s renders without crashing', (_label, Page) => {
        const html = renderToString(<Page />);
        expect(html.length).toBeGreaterThan(0);
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

    it('explains the two-knob pricing model without touching the network', () => {
        const network = vi.fn().mockRejectedValue(new Error('SSR network is sealed'));
        vi.stubGlobal('fetch', network);
        try {
            const html = renderToString(<PricingPage />);
            expect(html).toContain('客户价 = 模型基础价(官方 $)× 档次倍率');
            expect(html).toContain('档次倍率');
            expect(html).toContain('模型基础价');
            expect(html).toContain('价格总览');
            expect(network).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

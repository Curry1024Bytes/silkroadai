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
});

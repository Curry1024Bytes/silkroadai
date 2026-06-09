import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

// /admin/customers/[id] is a 'use client' page reading next/navigation hooks
// (useParams + useSearchParams). Mock them so renderToString produces the
// initial (loading) markup under node — effects (the data fetch) don't run in
// SSR, so this smokes the shell + the P4c-1 ledger panel + the P4c-4
// billing-mode flip wiring compiles and mounts without crashing.
vi.mock('next/navigation', () => ({
    useParams: () => ({ id: 'u-1' }),
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/admin/customers/u-1',
}));

import CustomerDetailPage from '@/app/admin/(console)/customers/[id]/page';

describe('admin customer detail page — SSR smoke (P4c-1 ledger panel)', () => {
    it('renders without crashing', () => {
        const html = renderToString(<CustomerDetailPage />);
        expect(html.length).toBeGreaterThan(0);
    });
});

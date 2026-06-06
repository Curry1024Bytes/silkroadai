import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

// The console pages are 'use client' components that read next/navigation
// hooks. Mock them so renderToString can produce the initial (loading) markup
// under node. Effects (the data fetch) don't run during SSR, so we only
// exercise the shell + loading state — exactly what we want to smoke after
// removing the URL `?token=` plumbing.
vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/admin',
}));

import AdminHome from '@/app/admin/(console)/page';
import AdminDashboard from '@/app/admin/(console)/dashboard/page';
import AdminOrders from '@/app/admin/(console)/orders/page';
import AdminChannels from '@/app/admin/(console)/channels/page';
import AdminPaymentConfig from '@/app/admin/(console)/payment-config/page';
import AdminSubscriptions from '@/app/admin/(console)/subscriptions/page';

const PAGES = [
    ['/admin', AdminHome],
    ['/admin/dashboard', AdminDashboard],
    ['/admin/orders', AdminOrders],
    ['/admin/channels', AdminChannels],
    ['/admin/payment-config', AdminPaymentConfig],
    ['/admin/subscriptions', AdminSubscriptions],
] as const;

describe('admin console pages — SSR smoke (post token-removal)', () => {
    it.each(PAGES)('%s renders without crashing and without the old token gate', (_label, Page) => {
        const html = renderToString(<Page />);
        expect(html.length).toBeGreaterThan(0);
        // The "missing admin token" render guard was removed — auth is now a
        // cookie session enforced by the server layout, so these never show.
        expect(html).not.toContain('缺少管理员凭证');
        expect(html).not.toContain('Missing admin token');
    });
});

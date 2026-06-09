/**
 * /usage — merged into the unified /dashboard console (客户控制台三合一).
 *
 * The page is now a thin 307 redirect to /dashboard (usage summary, chart,
 * per-model breakdown, and the per-call detail table moved there). It
 * forwards the `?period=` querystring so a bookmarked window survives the
 * redirect. The merged-page behaviour is covered in dashboard-page.test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockRedirect = vi.fn();
vi.mock('next/navigation', () => ({
    redirect: (...args: unknown[]) => mockRedirect(...args),
}));

import UsagePage from '@/app/(authenticated)/usage/page';

afterEach(() => {
    vi.clearAllMocks();
});

describe('/usage redirect (客户控制台三合一)', () => {
    it('307-redirects to /dashboard when no period querystring', async () => {
        await UsagePage({ searchParams: Promise.resolve({}) });
        expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
    });

    it('forwards a valid period to /dashboard', async () => {
        await UsagePage({ searchParams: Promise.resolve({ period: '7d' }) });
        expect(mockRedirect).toHaveBeenCalledWith('/dashboard?period=7d');
    });

    it('takes the first value when period arrives as an array', async () => {
        await UsagePage({ searchParams: Promise.resolve({ period: ['30d', 'junk'] }) });
        expect(mockRedirect).toHaveBeenCalledWith('/dashboard?period=30d');
    });

    it('redirects with no args (no searchParams prop)', async () => {
        await UsagePage({});
        expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
    });
});

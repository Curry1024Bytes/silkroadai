/**
 * /balance — merged into the unified /dashboard console (客户控制台三合一).
 *
 * The page is now a thin 307 redirect to /dashboard (the balance cards,
 * recharge history, and alert-threshold form moved there). This test pins
 * that contract; the merged-page behaviour is covered in dashboard-page.test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockRedirect = vi.fn();
vi.mock('next/navigation', () => ({
    redirect: (...args: unknown[]) => mockRedirect(...args),
}));

import BalancePage from '@/app/(authenticated)/balance/page';

afterEach(() => {
    vi.clearAllMocks();
});

describe('/balance redirect (客户控制台三合一)', () => {
    it('307-redirects to /dashboard so old bookmarks do not 404', () => {
        BalancePage();
        expect(mockRedirect).toHaveBeenCalledTimes(1);
        expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
    });
});

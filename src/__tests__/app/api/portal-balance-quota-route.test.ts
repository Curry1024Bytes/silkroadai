import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = vi.fn();
const mockGetCustomerBalance = vi.fn();

vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));
vi.mock('@/lib/billing/customer-balance', () => ({
    getCustomerBalance: (...args: unknown[]) => mockGetCustomerBalance(...args),
}));
vi.mock('@/lib/newapi/quota-units', () => ({
    REAL_USD_TO_CNY: 7.2,
}));

import { GET } from '@/app/api/portal/balance/quota/route';

const request = () => new NextRequest('https://example.test/api/portal/balance/quota');

beforeEach(() => {
    vi.clearAllMocks();
});

describe('GET /api/portal/balance/quota', () => {
    it('uses the real USD/CNY rate for USD display fields', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: 'portal-user-1' });
        mockGetCustomerBalance.mockResolvedValue({
            balanceCny: 72,
            spentCny: 14.4,
            source: 'newapi',
            stale: false,
            quota: { remain: 36_000_000, used: 7_200_000 },
        });

        const response = await GET(request());
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            remain_cny: 72,
            used_cny: 14.4,
            remain_usd: 10,
            used_usd: 2,
            remain_quota: 36_000_000,
            used_quota: 7_200_000,
        });
    });

    it('requires a signed-in customer', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        const response = await GET(request());
        expect(response.status).toBe(401);
        expect(mockGetCustomerBalance).not.toHaveBeenCalled();
    });
});

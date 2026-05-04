/**
 * W4-2 D6 — /balance page server-component render smoke.
 *
 * Same pattern as src/__tests__/app/authenticated/layout.test.tsx —
 * mock next/headers + getCurrentUser + getQuotaWithCache + prisma, then
 * call the async page function and renderToString the JSX.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Prisma } from '@prisma/client';

const mockHeadersGet = vi.fn<(name: string) => string | null>();
vi.mock('next/headers', () => ({
    headers: vi.fn(async () => ({ get: mockHeadersGet })),
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockGetQuotaWithCache = vi.fn();
vi.mock('@/lib/newapi/quota-cache', () => ({
    getQuotaWithCache: (...args: unknown[]) => mockGetQuotaWithCache(...args),
}));

const mockRechargeLogFindMany = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        rechargeLog: {
            findMany: (...args: unknown[]) => mockRechargeLogFindMany(...args),
        },
    },
}));

import BalancePage from '@/app/(authenticated)/balance/page';

const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION_USER = { id: PORTAL_USER_ID, email: 'happy@silkroadai.io' };

beforeEach(() => {
    vi.clearAllMocks();
    mockHeadersGet.mockReturnValue('silkroad_session=fake-jwt');
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('<BalancePage /> SSR smoke', () => {
    it('renders ¥ + USD + raw quota for live snapshot, with empty history hint', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockGetQuotaWithCache.mockResolvedValue({
            // 694_444 quota ≈ ¥10.00 (1 USD = 7.2 CNY = 500_000 quota)
            remain_quota: 694_444,
            used_quota: 138_888,
            source: 'live',
        });
        mockRechargeLogFindMany.mockResolvedValue([]);

        const tree = await BalancePage();
        const html = renderToString(tree);

        // CNY display (rounded to 2dp)
        expect(html).toMatch(/¥(<!-- -->)?10\.00/);
        expect(html).toMatch(/¥(<!-- -->)?2\.00/); // used_quota = 138_888 ≈ ¥2.00
        // USD subtitle
        expect(html).toContain('USD');
        // Raw quota with thousands sep
        expect(html).toContain('694,444');
        // Empty history hint
        expect(html).toContain('暂无充值记录');
        // 充值 CTA on top
        expect(html).toContain('+ 充值');
        // No fallback / error banner on live source
        expect(html).not.toContain('数据暂时不可更新');
        expect(html).not.toContain('当前无法获取余额');
    });

    it('shows "数据暂时不可更新" banner when source=fallback', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockGetQuotaWithCache.mockResolvedValue({
            remain_quota: 694_444,
            used_quota: 0,
            source: 'fallback',
        });
        mockRechargeLogFindMany.mockResolvedValue([]);

        const html = renderToString(await BalancePage());
        expect(html).toContain('数据暂时不可更新');
        // Numbers still rendered (we have data, just stale)
        expect(html).toMatch(/¥(<!-- -->)?10\.00/);
    });

    it('does NOT show fallback banner when source=cache (fresh)', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockGetQuotaWithCache.mockResolvedValue({
            remain_quota: 1_388_888, // ≈ ¥20.00
            used_quota: 0,
            source: 'cache',
        });
        mockRechargeLogFindMany.mockResolvedValue([]);

        const html = renderToString(await BalancePage());
        expect(html).not.toContain('数据暂时不可更新');
        expect(html).toMatch(/¥(<!-- -->)?20\.00/);
    });

    it('shows error banner when getQuotaWithCache throws (no cache + new-api dead)', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockGetQuotaWithCache.mockRejectedValue(new Error('quota fetch failed: ...'));
        mockRechargeLogFindMany.mockResolvedValue([]);

        const html = renderToString(await BalancePage());
        expect(html).toContain('当前无法获取余额');
        // Cards must NOT render when quota fetch failed (avoid showing ¥0.00 misleadingly)
        expect(html).not.toContain('可用余额');
        expect(html).not.toContain('累计消费');
        // History section still renders (independent of quota fetch)
        expect(html).toContain('充值流水');
    });

    it('renders history table with friendly source labels + 8-char order id prefix', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockGetQuotaWithCache.mockResolvedValue({
            remain_quota: 694_444,
            used_quota: 0,
            source: 'live',
        });
        mockRechargeLogFindMany.mockResolvedValue([
            {
                id: 'rl-1',
                order_id: 'order-abcdefgh-rest-of-cuid',
                amount: new Prisma.Decimal('10.0000'),
                source: 'payment',
                created_at: new Date('2026-05-04T10:00:00Z'),
            },
            {
                id: 'rl-2',
                order_id: null,
                amount: new Prisma.Decimal('5.0000'),
                source: 'manual',
                created_at: new Date('2026-05-03T10:00:00Z'),
            },
        ]);

        const html = renderToString(await BalancePage());
        // Friendly labels
        expect(html).toContain('在线支付');
        expect(html).toContain('管理员充值');
        // 8-char order id prefix
        expect(html).toContain('order-ab');
        // Null order_id rendered as em-dash placeholder
        expect(html).toContain('—');
        // Empty-state hint NOT shown when rows exist
        expect(html).not.toContain('暂无充值记录');
    });

    it('passes user_id scope to prisma.rechargeLog.findMany (no cross-user leak)', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockGetQuotaWithCache.mockResolvedValue({
            remain_quota: 0,
            used_quota: 0,
            source: 'live',
        });
        mockRechargeLogFindMany.mockResolvedValue([]);

        await BalancePage();

        expect(mockRechargeLogFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { user_id: PORTAL_USER_ID },
                orderBy: { created_at: 'desc' },
                take: 10,
            }),
        );
    });
});

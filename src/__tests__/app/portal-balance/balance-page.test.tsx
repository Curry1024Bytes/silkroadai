/**
 * W4-2 D6 — /balance page server-component render smoke.
 * P4c-3.5 — page now reads via getCustomerBalance (portal → Account; newapi → quota).
 *
 * Mock next/headers + getCurrentUser + getCustomerBalance + prisma, then call
 * the async page function and renderToString the JSX.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Prisma } from '@prisma/client';
import { quotaToCny } from '@/lib/newapi/quota-units';

const mockHeadersGet = vi.fn<(name: string) => string | null>();
vi.mock('next/headers', () => ({
    headers: vi.fn(async () => ({ get: mockHeadersGet })),
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockGetCustomerBalance = vi.fn();
vi.mock('@/lib/billing/customer-balance', () => ({
    getCustomerBalance: (...args: unknown[]) => mockGetCustomerBalance(...args),
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

/** newapi-mode CustomerBalance: ¥ from quota + raw quota for the sub-display. */
const newapiBal = (remain: number, used: number, stale = false) => ({
    balanceCny: quotaToCny(remain),
    spentCny: quotaToCny(used),
    source: 'newapi' as const,
    stale,
    quota: { remain, used },
});

beforeEach(() => {
    vi.clearAllMocks();
    mockHeadersGet.mockReturnValue('silkroad_session=fake-jwt');
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('<BalancePage /> SSR smoke', () => {
    it('renders ¥ + USD + raw quota for a newapi live snapshot, with empty history hint', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        // 694_444 quota ≈ ¥10.00; 138_888 ≈ ¥2.00 (1 USD = 7.2 CNY = 500_000 quota)
        mockGetCustomerBalance.mockResolvedValue(newapiBal(694_444, 138_888));
        mockRechargeLogFindMany.mockResolvedValue([]);

        const tree = await BalancePage();
        const html = renderToString(tree);

        expect(html).toMatch(/¥(<!-- -->)?10\.00/);
        expect(html).toMatch(/¥(<!-- -->)?2\.00/);
        expect(html).toContain('USD');
        // newapi: raw quota sub-display with thousands sep
        expect(html).toContain('694,444');
        expect(html).toContain('暂无充值记录');
        expect(html).toContain('+ 充值');
        expect(html).not.toContain('数据暂时不可更新');
        expect(html).not.toContain('当前无法获取余额');
    });

    it('P4c-3.5: portal customer renders the ¥ Account balance + NO raw-quota sub-display', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        // portal: balance from Account.balance_cny, spent from Σ|charge|; no quota concept.
        mockGetCustomerBalance.mockResolvedValue({
            balanceCny: 33.5,
            spentCny: 6.5,
            source: 'portal',
            stale: false,
            quota: null,
        });
        mockRechargeLogFindMany.mockResolvedValue([]);

        const html = renderToString(await BalancePage());
        expect(html).toMatch(/¥(<!-- -->)?33\.50/); // available balance from the ledger
        expect(html).toMatch(/¥(<!-- -->)?6\.50/); // cumulative spend
        // portal has no new-api quota → the "· N quota" sub-display is absent
        expect(html).not.toContain('quota');
        expect(html).not.toContain('数据暂时不可更新');
    });

    it('shows "数据暂时不可更新" banner when newapi balance is stale (new-api unreachable)', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockGetCustomerBalance.mockResolvedValue(newapiBal(694_444, 0, true));
        mockRechargeLogFindMany.mockResolvedValue([]);

        const html = renderToString(await BalancePage());
        expect(html).toContain('数据暂时不可更新');
        expect(html).toMatch(/¥(<!-- -->)?10\.00/);
    });

    it('does NOT show fallback banner when balance is fresh', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockGetCustomerBalance.mockResolvedValue(newapiBal(1_388_888, 0)); // ≈ ¥20.00
        mockRechargeLogFindMany.mockResolvedValue([]);

        const html = renderToString(await BalancePage());
        expect(html).not.toContain('数据暂时不可更新');
        expect(html).toMatch(/¥(<!-- -->)?20\.00/);
    });

    it('shows error banner when getCustomerBalance throws (no cache + new-api dead)', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockGetCustomerBalance.mockRejectedValue(new Error('quota fetch failed: ...'));
        mockRechargeLogFindMany.mockResolvedValue([]);

        const html = renderToString(await BalancePage());
        expect(html).toContain('当前无法获取余额');
        expect(html).not.toContain('可用余额');
        expect(html).not.toContain('累计消费');
        expect(html).toContain('充值流水');
    });

    it('renders history table with friendly source labels + 8-char order id prefix', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockGetCustomerBalance.mockResolvedValue(newapiBal(694_444, 0));
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
        expect(html).toContain('在线支付');
        expect(html).toContain('管理员充值');
        expect(html).toContain('order-ab');
        expect(html).toContain('—');
        expect(html).not.toContain('暂无充值记录');
    });

    it('passes user_id scope to prisma.rechargeLog.findMany (no cross-user leak)', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockGetCustomerBalance.mockResolvedValue(newapiBal(0, 0));
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

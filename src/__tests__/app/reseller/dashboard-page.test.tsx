/**
 * /reseller/dashboard SSR smoke — zh (default) + en (feat/i18n-zh-en).
 *
 * Mocks at the boundary (session / fetchResellerStatus / prisma) so the
 * render is deterministic. The locale is controlled through a hoisted
 * switch feeding the `@/lib/i18n/server` mock; the page passes the
 * resolved locale down to the sync <TierBadge /> child.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const state = vi.hoisted(() => ({ locale: 'zh' as 'zh' | 'en' }));

vi.mock('@/lib/i18n/server', () => ({
    getLocale: async () => state.locale,
    getMessages: async (d: { zh: unknown; en: unknown }) => d[state.locale],
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockHeadersGet = vi.fn();
vi.mock('next/headers', () => ({
    headers: vi.fn(async () => ({ get: mockHeadersGet })),
}));

const mockRedirect = vi.fn((url: string) => {
    throw Object.assign(new Error('REDIRECT'), { _redirectUrl: url });
});
vi.mock('next/navigation', () => ({
    redirect: (url: string) => mockRedirect(url),
}));

const mockFetchResellerStatus = vi.fn();
vi.mock('@/lib/reseller/fetch-status', () => ({
    fetchResellerStatus: (...args: unknown[]) => mockFetchResellerStatus(...args),
}));

const mockResellerFindUnique = vi.fn();
const mockCommissionGroupBy = vi.fn();
const mockUserCount = vi.fn();
const mockCodeCount = vi.fn();
const mockSettlementFindFirst = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        reseller: { findUnique: (...a: unknown[]) => mockResellerFindUnique(...a) },
        resellerCommission: { groupBy: (...a: unknown[]) => mockCommissionGroupBy(...a) },
        user: { count: (...a: unknown[]) => mockUserCount(...a) },
        resellerInviteCode: { count: (...a: unknown[]) => mockCodeCount(...a) },
        resellerSettlement: { findFirst: (...a: unknown[]) => mockSettlementFindFirst(...a) },
    },
}));

import ResellerDashboardPage, { generateMetadata } from '@/app/(authenticated)/reseller/dashboard/page';

function strip(html: string): string {
    return html.replace(/<!-- -->/g, '');
}

const USER = { id: 'aaaa-1111-1111-1111', email: 'a@b.io' };

beforeEach(() => {
    vi.clearAllMocks();
    state.locale = 'zh';
    mockGetCurrentUser.mockReturnValue(USER);
    mockHeadersGet.mockReturnValue('silkroad_session=fake');
    mockFetchResellerStatus.mockResolvedValue({ status: 'active', isReseller: true, tier: 'silver' });
    mockResellerFindUnique.mockResolvedValue({
        id: 'r-1',
        user_id: USER.id,
        tier: 'silver',
        cumulative_gmv: 25_000,
    });
    mockCommissionGroupBy.mockResolvedValue([
        { status: 'pending', _sum: { attributed_gmv: 1_000, commission_amount: 150 } },
        { status: 'confirmed', _sum: { attributed_gmv: 2_000, commission_amount: 300 } },
    ]);
    mockUserCount.mockResolvedValue(12);
    mockCodeCount.mockResolvedValue(3);
    mockSettlementFindFirst.mockResolvedValue({
        period_month: '2026-09',
        status: 'paid',
        total_commission: 500,
        paid_at: null,
    });
});

describe('/reseller/dashboard', () => {
    it('non-reseller → redirects to /reseller', async () => {
        mockFetchResellerStatus.mockResolvedValueOnce({ status: null, isReseller: false });
        await expect(ResellerDashboardPage()).rejects.toThrow('REDIRECT');
        expect(mockRedirect).toHaveBeenCalledWith('/reseller');
    });

    it('zh (default) → hero, tier badge, progress, month strip and quick actions', async () => {
        const html = strip(renderToString(await ResellerDashboardPage()));
        expect(html).toContain('代理身份');
        expect(html).toContain('代理后台');
        expect(html).toContain('白银');
        expect(html).toContain('¥25,000.00');
        expect(html).toContain('累计 GMV');
        expect(html).toContain('距离下一档');
        expect(html).toContain('GOLD');
        expect(html).toContain('¥75,000.00 待累积');
        expect(html).toContain('本月 GMV');
        expect(html).toContain('¥3,000.00');
        expect(html).toContain('本月待确认佣金');
        expect(html).toContain('¥150.00');
        expect(html).toContain('本月可结算佣金');
        expect(html).toContain('¥300.00');
        expect(html).toContain('邀请码 (3)');
        expect(html).toContain('客户列表 (12)');
        expect(html).toContain('佣金明细');
        expect(html).toContain('上一笔 2026-09 · paid');
        await expect(generateMetadata()).resolves.toEqual({ title: '代理后台 — Silk Road AI' });
    });

    it('gold tier (zh) → top-tier message instead of progress bar', async () => {
        mockResellerFindUnique.mockResolvedValueOnce({ id: 'r-1', tier: 'gold', cumulative_gmv: 250_000 });
        mockSettlementFindFirst.mockResolvedValueOnce(null);
        const html = strip(renderToString(await ResellerDashboardPage()));
        expect(html).toContain('已达最高档 Gold');
        expect(html).not.toContain('距离下一档');
        expect(html).toContain('尚无结算记录');
    });

    it('en → English copy, English tier label, locale-aware numbers', async () => {
        state.locale = 'en';
        const html = strip(renderToString(await ResellerDashboardPage()));
        expect(html).toContain('Reseller account');
        expect(html).toContain('Reseller console');
        expect(html).toContain('Silver');
        expect(html).toContain('Total GMV');
        expect(html).toContain('¥25,000.00');
        expect(html).toContain('Next tier: ');
        expect(html).toContain('¥75,000.00 to go');
        expect(html).toContain('GMV this month');
        expect(html).toContain('Pending commission this month');
        expect(html).toContain('Payable commission this month');
        expect(html).toContain('Invite codes (3)');
        expect(html).toContain('Customers (12)');
        expect(html).toContain('Last: 2026-09 · paid');
        expect(html).not.toContain('代理后台');
        expect(html).not.toContain('白银');
        await expect(generateMetadata()).resolves.toEqual({ title: 'Reseller console — Silk Road AI' });
    });
});

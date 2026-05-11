/**
 * W6 D5 — /dashboard SSR smoke.
 *
 * Mocks at the boundary (getCurrentUser + getQuotaWithCache +
 * getUsageAggregate) so the page renders with deterministic numbers.
 * Asserts on the contract surface: 4 cards' labels + numbers + quick
 * links. Same shallow react-dom/server pattern as W6 D2 / W6 D4 SSR
 * tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockGetQuotaWithCache = vi.fn();
vi.mock('@/lib/newapi/quota-cache', () => ({
    getQuotaWithCache: (...args: unknown[]) => mockGetQuotaWithCache(...args),
}));

const mockGetUsageAggregate = vi.fn();
vi.mock('@/lib/newapi/usage-aggregate', () => ({
    getUsageAggregate: (...args: unknown[]) => mockGetUsageAggregate(...args),
}));

vi.mock('next/headers', () => ({
    headers: vi.fn(() => Promise.resolve({ get: () => 'silkroad_session=fake-cookie' })),
}));

// Use the actual quotaToCny / quotaToUsd so the rendered numbers
// exercise the production path.
vi.mock('@/lib/newapi/client', async () => {
    const actual = await vi.importActual<typeof import('@/lib/newapi/client')>('@/lib/newapi/client');
    return actual;
});

// fix/reseller-entry-discovery: dashboard now reads reseller status to
// gate the bottom promo card. Mock the helper so this test stays a pure
// SSR smoke without needing a `resellers` table on the test DB.
// Default = null (non-reseller) — most existing assertions don't care
// either way. Tests that want to assert the card's visibility override
// per-call via mockResolvedValueOnce.
vi.mock('@/lib/reseller/fetch-status', () => ({
    fetchResellerStatus: vi.fn(async () => ({ status: null, isReseller: false })),
}));

import DashboardPage from '@/app/(authenticated)/dashboard/page';

const SAMPLE_USER = {
    id: 'aaaa-1111-1111-1111',
    email: 'happy@silkroadai.io',
    nickname: null,
    newapi_user_id: 7,
    // W7 D4 PR-J Bug 2: dashboard now reads newapi_username for the
    // aggregator (admin auth ignores user_id, gotcha #15).
    newapi_username: 'c-aaaa1111',
};

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('<DashboardPage /> SSR — happy path (W6 D5)', () => {
    it('renders 4 real data cards + quick links when all fetches succeed', async () => {
        mockGetCurrentUser.mockResolvedValue(SAMPLE_USER);
        // 500_000 quota = 1 USD = ~¥7.20
        mockGetQuotaWithCache.mockResolvedValue({
            remain_quota: 500_000,
            used_quota: 100_000,
            source: 'live',
        });
        // last_month
        mockGetUsageAggregate.mockResolvedValueOnce({
            totalUsedQuota: 250_000,
            totalCalls: 100,
            byModel: [],
            period: 'last_month',
            source: 'live',
            computedAt: new Date(),
            pagesFetched: 1,
        });
        // all_time
        mockGetUsageAggregate.mockResolvedValueOnce({
            totalUsedQuota: 1_000_000,
            totalCalls: 500,
            byModel: [],
            period: 'all',
            source: 'live',
            computedAt: new Date(),
            pagesFetched: 1,
        });
        // top_3 (30d)
        mockGetUsageAggregate.mockResolvedValueOnce({
            totalUsedQuota: 600_000,
            totalCalls: 250,
            byModel: [
                { model: 'gpt-4o', calls: 150, quota: 400_000 },
                { model: 'claude-opus-4-7', calls: 80, quota: 150_000 },
                { model: 'deepseek-v4-flash', calls: 20, quota: 50_000 },
            ],
            period: '30d',
            source: 'live',
            computedAt: new Date(),
            pagesFetched: 1,
        });

        const el = await DashboardPage();
        const html = renderToString(el);

        // Card labels present
        expect(html).toContain('当前余额');
        expect(html).toContain('上月消费');
        expect(html).toContain('累计调用次数');
        expect(html).toContain('最常用模型');

        // Card 1: ¥7.20 from 500_000 quota
        expect(html).toMatch(/¥(<!-- -->)?7\.20/);
        // Card 2: ¥3.60 from 250_000 quota (last_month)
        expect(html).toMatch(/¥(<!-- -->)?3\.60/);
        // Card 3: 500 calls accumulated
        expect(html).toMatch(/(<!-- -->)?500(<!-- -->)?/);
        // Card 4: top model names visible
        expect(html).toContain('gpt-4o');
        expect(html).toContain('claude-opus-4-7');
        expect(html).toContain('deepseek-v4-flash');

        // Quick links — all 4 entries
        expect(html).toContain('href="/pay"');
        expect(html).toContain('href="/keys"');
        expect(html).toContain('href="/usage"');
        expect(html).toContain('href="/models"');
        // Labels for each
        expect(html).toContain('充值');
        expect(html).toContain('管理 Keys');
        expect(html).toContain('查看用量');
        expect(html).toContain('模型清单');
    });

    it('shows nickname when present, else email local-part', async () => {
        mockGetCurrentUser.mockResolvedValue({ ...SAMPLE_USER, nickname: 'Alice' });
        mockGetQuotaWithCache.mockResolvedValue({
            remain_quota: 0,
            used_quota: 0,
            source: 'live',
        });
        mockGetUsageAggregate.mockResolvedValue({
            totalUsedQuota: 0,
            totalCalls: 0,
            byModel: [],
            period: 'all',
            source: 'live',
            computedAt: new Date(),
            pagesFetched: 0,
        });

        const html = renderToString(await DashboardPage());
        expect(html).toMatch(/欢迎,(<!-- -->)?Alice/);
    });
});

describe('<DashboardPage /> SSR — empty / error states', () => {
    beforeEach(() => {
        mockGetCurrentUser.mockResolvedValue(SAMPLE_USER);
    });

    it('falls through to "暂无数据" per card when fetches reject', async () => {
        mockGetQuotaWithCache.mockRejectedValue(new Error('quota-fail'));
        mockGetUsageAggregate.mockRejectedValue(new Error('aggregate-fail'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const html = renderToString(await DashboardPage());
        // 3 of the 4 cards render 暂无数据 (top-3 falls through to 暂无调用)
        const noDataCount = (html.match(/暂无数据/g) ?? []).length;
        expect(noDataCount).toBeGreaterThanOrEqual(3);
        // Top-3 card has its own copy when byModel is empty
        expect(html).toContain('暂无调用');

        warnSpy.mockRestore();
    });

    it('top-3 card renders 暂无调用 when byModel is empty (no calls yet)', async () => {
        mockGetQuotaWithCache.mockResolvedValue({
            remain_quota: 0,
            used_quota: 0,
            source: 'live',
        });
        mockGetUsageAggregate.mockResolvedValue({
            totalUsedQuota: 0,
            totalCalls: 0,
            byModel: [],
            period: '30d',
            source: 'live',
            computedAt: new Date(),
            pagesFetched: 0,
        });

        const html = renderToString(await DashboardPage());
        expect(html).toContain('暂无调用');
    });

    it('shows "数据稍滞后" hint when aggregate source=fallback (stale cache)', async () => {
        mockGetQuotaWithCache.mockResolvedValue({
            remain_quota: 100_000,
            used_quota: 0,
            source: 'live',
        });
        // last_month is fallback; the others are fresh
        mockGetUsageAggregate
            .mockResolvedValueOnce({
                totalUsedQuota: 50_000,
                totalCalls: 10,
                byModel: [],
                period: 'last_month',
                source: 'fallback',
                computedAt: new Date(Date.now() - 30 * 60_000),
                pagesFetched: 0,
            })
            .mockResolvedValueOnce({
                totalUsedQuota: 200_000,
                totalCalls: 40,
                byModel: [],
                period: 'all',
                source: 'live',
                computedAt: new Date(),
                pagesFetched: 1,
            })
            .mockResolvedValueOnce({
                totalUsedQuota: 100_000,
                totalCalls: 20,
                byModel: [{ model: 'gpt-4', calls: 20, quota: 100_000 }],
                period: '30d',
                source: 'live',
                computedAt: new Date(),
                pagesFetched: 1,
            });

        const html = renderToString(await DashboardPage());
        // Stale hint shown for the last_month card
        expect(html).toContain('数据稍滞后');
    });

    it('user without newapi_user_id renders 暂无数据 on aggregate cards (balance still works)', async () => {
        mockGetCurrentUser.mockResolvedValue({ ...SAMPLE_USER, newapi_user_id: null });
        mockGetQuotaWithCache.mockResolvedValue({
            remain_quota: 0,
            used_quota: 0,
            source: 'live',
        });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const html = renderToString(await DashboardPage());
        expect(html).toContain('暂无数据');
        warnSpy.mockRestore();
    });
});

describe('<DashboardPage /> SSR — reseller promo card (fix/reseller-entry-discovery)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetCurrentUser.mockReturnValue(SAMPLE_USER);
        mockGetQuotaWithCache.mockResolvedValue({
            remain_quota: 1_000_000,
            used_quota: 100_000,
            source: 'live',
        });
        // 4 calls to getUsageAggregate (last_month / all / 30d / unused 4th
        // for safety) — every test in this block fans out a default
        // success so we can focus on the promo card assertion only.
        mockGetUsageAggregate.mockResolvedValue({
            totalUsedQuota: 0,
            totalCalls: 0,
            byModel: [],
            period: 'last_month',
            source: 'live',
            computedAt: new Date(),
            pagesFetched: 1,
        });
    });

    async function renderWithStatus(status: 'active' | 'suspended' | 'banned' | null) {
        // Re-mock per-test so we control the visibility gate independently.
        const mod = await import('@/lib/reseller/fetch-status');
        (mod.fetchResellerStatus as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
            status,
            isReseller: status === 'active',
            tier: status === 'active' ? 'bronze' : undefined,
        });
        return renderToString(await DashboardPage());
    }

    it('non-reseller (status=null) → promo card visible', async () => {
        const html = await renderWithStatus(null);
        expect(html).toContain('邀请朋友充值,你也赚佣金');
        expect(html).toContain('了解代理计划');
    });

    it('active reseller (status=active) → promo card HIDDEN', async () => {
        const html = await renderWithStatus('active');
        expect(html).not.toContain('邀请朋友充值,你也赚佣金');
    });

    it('suspended reseller (status=suspended) → promo card visible (was-joined re-engagement)', async () => {
        const html = await renderWithStatus('suspended');
        expect(html).toContain('邀请朋友充值,你也赚佣金');
    });

    it('banned reseller (status=banned) → promo card visible', async () => {
        const html = await renderWithStatus('banned');
        expect(html).toContain('邀请朋友充值,你也赚佣金');
    });
});

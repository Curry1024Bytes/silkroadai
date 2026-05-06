/**
 * W4-2 D7 + W6 D5 — /usage page server-component render smoke + period parsing.
 *
 * W6 D5 sweep: the page now calls `getUsageAggregate` for totals/by-model
 * AND `queryLogs(page_size=50)` for the recent-50 table. Both are mocked
 * here so tests don't hit a real DB / new-api.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockHeadersGet = vi.fn<(name: string) => string | null>();
vi.mock('next/headers', () => ({
    headers: vi.fn(async () => ({ get: mockHeadersGet })),
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockQueryLogs = vi.fn();
vi.mock('@/lib/newapi/client', async () => {
    return {
        queryLogs: (...args: unknown[]) => mockQueryLogs(...args),
        // Real conversion helpers (cheap, no I/O)
        quotaToCny: (q: number) => (q / 500_000) * 7.2,
        quotaToUsd: (q: number) => q / 500_000,
    };
});

const mockGetUsageAggregate = vi.fn();
vi.mock('@/lib/newapi/usage-aggregate', () => ({
    getUsageAggregate: (...args: unknown[]) => mockGetUsageAggregate(...args),
}));

import UsagePage from '@/app/(authenticated)/usage/page';

const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NEWAPI_USER_ID = 7;
const SESSION_USER = {
    id: PORTAL_USER_ID,
    email: 'happy@silkroadai.io',
    newapi_user_id: NEWAPI_USER_ID,
};

function makeLog(overrides: Partial<{ id: number; model_name: string; quota: number; created_at: number; type: number; completion_tokens: number }> = {}) {
    return {
        id: overrides.id ?? 1,
        user_id: NEWAPI_USER_ID,
        created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
        type: overrides.type ?? 2, // consume
        content: '',
        username: 'c-aaaa',
        token_name: 'production',
        model_name: overrides.model_name ?? 'gpt-4',
        quota: overrides.quota ?? 1000,
        prompt_tokens: 100,
        completion_tokens: overrides.completion_tokens ?? 200,
        use_time: 500,
        is_stream: false,
        channel: 1,
        token_id: 1,
        group: 'default',
    };
}

/** Compute the aggregate snapshot the page would expect, given a list of
 *  raw logs. Lets each test simulate "the aggregator saw the same logs"
 *  without a separate fixture. Re-uses production logic via the simple
 *  filter + sum below since this test isn't validating aggregator
 *  behaviour (that's covered in usage-aggregate.test.ts). */
function aggregateFor(period: string, logs: ReturnType<typeof makeLog>[]) {
    const consume = logs.filter((l) => l.type === 2);
    const totalUsedQuota = consume.reduce((a, l) => a + l.quota, 0);
    const totalCalls = consume.length;
    const byModelMap = new Map<string, { calls: number; quota: number }>();
    for (const l of consume) {
        const key = l.model_name || '<unknown>';
        const slot = byModelMap.get(key) ?? { calls: 0, quota: 0 };
        slot.calls++;
        slot.quota += l.quota;
        byModelMap.set(key, slot);
    }
    const byModel = Array.from(byModelMap.entries())
        .map(([model, agg]) => ({ model, ...agg }))
        .sort((a, b) => b.quota - a.quota);
    return {
        totalUsedQuota,
        totalCalls,
        byModel,
        period,
        source: 'live' as const,
        computedAt: new Date(),
        pagesFetched: 1,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockHeadersGet.mockReturnValue('silkroad_session=fake-jwt');
    // Default aggregator: empty result. Individual tests override.
    mockGetUsageAggregate.mockImplementation(async ({ period }: { period: string }) => ({
        totalUsedQuota: 0,
        totalCalls: 0,
        byModel: [],
        period,
        source: 'live' as const,
        computedAt: new Date(),
        pagesFetched: 0,
    }));
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('<UsagePage /> SSR smoke', () => {
    it('passes user_id (NOT username) to queryLogs — W3 D2 F2 fix', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockQueryLogs.mockResolvedValue({ items: [], total: 0 });

        await UsagePage({ searchParams: Promise.resolve({}) });

        expect(mockQueryLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                user_id: NEWAPI_USER_ID,
                type: 2, // consume only — excludes topup/manage noise
            }),
        );
        // CRITICAL: must NOT pass username (we know that filter is buggy)
        const callArgs = mockQueryLogs.mock.calls[0][0];
        expect(callArgs.username).toBeUndefined();
    });

    it('renders empty state with link to /keys when no logs', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockQueryLogs.mockResolvedValue({ items: [], total: 0 });

        const html = renderToString(await UsagePage({ searchParams: Promise.resolve({}) }));
        expect(html).toContain('该时间段内无 API 调用记录');
        // CTA links to /keys
        expect(html).toMatch(/href="\/keys"/);
        // No summary cards rendered when no data
        expect(html).not.toContain('总调用次数');
    });

    it('renders summary cards + by-model breakdown + recent table when logs exist', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        const logs = [
            makeLog({ id: 1, model_name: 'gpt-4', quota: 1000 }),
            makeLog({ id: 2, model_name: 'gpt-4', quota: 2000 }),
            makeLog({ id: 3, model_name: 'claude-opus-4-7', quota: 500 }),
            makeLog({ id: 4, model_name: 'deepseek-v4-flash', quota: 100 }),
            // Filter: type!=2 should be excluded from aggregation
            makeLog({ id: 5, model_name: 'noise', quota: 99_999_999, type: 1 }),
        ];
        // W6 D5: the aggregator now produces the totals + by-model. The
        // page also queries the recent-50 logs separately for the table.
        mockGetUsageAggregate.mockResolvedValue(aggregateFor('30d', logs));
        mockQueryLogs.mockResolvedValue({
            items: logs,
            total: 5,
        });

        const html = renderToString(await UsagePage({ searchParams: Promise.resolve({}) }));
        // 4 consume calls (type=2), the type=1 noise excluded by aggregator
        expect(html).toContain('总调用次数');
        // Summary block: total quota = 1000+2000+500+100 = 3600 → ¥0.05
        expect(html).toMatch(/¥(<!-- -->)?0\.05/);
        // By-model header (gpt-4 dominates with 3000)
        expect(html).toContain('按模型 Top');
        expect(html).toContain('gpt-4');
        expect(html).toContain('claude-opus-4-7');
        expect(html).toContain('deepseek-v4-flash');
        // Noise excluded by aggregator's type=2 filter
        expect(html).not.toContain('99,999,999');
        // Recent calls table header present
        expect(html).toContain('最近调用');
        // disabled "查看更多" placeholder for W6
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="W6/);
    });

    it('renders error banner when usage aggregator hard-fails (no cache + new-api dead)', async () => {
        // W6 D5 sweep: queryErr is now driven by the aggregator's hard-fail
        // (no cache row + live fetch threw). The recent-50 queryLogs runs
        // in parallel via allSettled — its failure alone is non-fatal.
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockGetUsageAggregate.mockRejectedValue(
            new Error('usage aggregate fetch failed: new-api 503'),
        );
        mockQueryLogs.mockRejectedValue(new Error('new-api 503'));

        const html = renderToString(await UsagePage({ searchParams: Promise.resolve({}) }));
        expect(html).toContain('当前无法获取用量数据');
        // Don't render summary cards or empty-state hint when erroring
        expect(html).not.toContain('总调用次数');
        expect(html).not.toContain('该时间段内无');
    });

    it('renders account_not_provisioned alert when user has no newapi_user_id', async () => {
        mockGetCurrentUser.mockResolvedValue({ ...SESSION_USER, newapi_user_id: null });

        const html = renderToString(await UsagePage({ searchParams: Promise.resolve({}) }));
        expect(html).toContain('账户尚未关联到上游');
        // queryLogs MUST NOT be invoked
        expect(mockQueryLogs).not.toHaveBeenCalled();
    });
});

describe('<UsagePage /> period filter', () => {
    it('default period is 30d (no querystring)', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockQueryLogs.mockResolvedValue({ items: [], total: 0 });

        const before = Math.floor(Date.now() / 1000);
        await UsagePage({ searchParams: Promise.resolve({}) });
        const after = Math.floor(Date.now() / 1000);

        const args = mockQueryLogs.mock.calls[0][0];
        // Should pass start_timestamp ≈ now - 30 days
        expect(args.start_timestamp).toBeGreaterThanOrEqual(before - 30 * 86_400 - 5);
        expect(args.start_timestamp).toBeLessThanOrEqual(after - 30 * 86_400 + 5);
    });

    it('period=7d narrows the window', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockQueryLogs.mockResolvedValue({ items: [], total: 0 });

        await UsagePage({ searchParams: Promise.resolve({ period: '7d' }) });

        const args = mockQueryLogs.mock.calls[0][0];
        const expectStart = Math.floor(Date.now() / 1000) - 7 * 86_400;
        expect(args.start_timestamp).toBeCloseTo(expectStart, -2);
    });

    it('period=all omits start_timestamp (scan all-time)', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockQueryLogs.mockResolvedValue({ items: [], total: 0 });

        await UsagePage({ searchParams: Promise.resolve({ period: 'all' }) });

        const args = mockQueryLogs.mock.calls[0][0];
        // Period 'all' computes start=0, which the page omits as undefined
        expect(args.start_timestamp).toBeUndefined();
    });

    it('invalid period falls back to 30d (defense against arbitrary querystring)', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockQueryLogs.mockResolvedValue({ items: [], total: 0 });

        await UsagePage({
            searchParams: Promise.resolve({ period: '../../etc/passwd' }),
        });

        const args = mockQueryLogs.mock.calls[0][0];
        const expectStart = Math.floor(Date.now() / 1000) - 30 * 86_400;
        expect(args.start_timestamp).toBeCloseTo(expectStart, -2);
    });
});

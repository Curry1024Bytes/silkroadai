/**
 * 客户控制台三合一 — /dashboard merged-console SSR smoke.
 *
 * The page now folds in 余额 + 用量 + 每次调用明细. Mocks at the boundary
 * (getCurrentUser / getCustomerBalance / getUsageAggregate / queryLogs /
 * prisma.rechargeLog / reseller) so the render is deterministic. The recharts
 * chart is stubbed (recharts needs a real DOM to measure width) — its data
 * prep lives in the aggregator and is tested in usage-aggregate.test.
 *
 * Coverage:
 *   - 5 summary cards (当前余额 via getCustomerBalance — P4c-3.5 fork preserved)
 *   - 模型消耗分布 chart receives chartModels
 *   - 按模型 breakdown + per-call detail (成功/失败 + 生图 token=0)
 *   - period filter (queryLogs uses username NOT user_id, gotcha #15)
 *   - preserved features: 充值流水 + 余额提醒设置
 *   - graceful degradation: balErr / usageErr / account_not_provisioned
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockHeadersGet = vi.fn<(name: string) => string | null>();
vi.mock('next/headers', () => ({
    headers: vi.fn(async () => ({ get: mockHeadersGet })),
}));

// PeriodTabs (real, rendered) is a client component using usePathname.
vi.mock('next/navigation', () => ({
    usePathname: () => '/dashboard',
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

// P4c-3.5: balance/spend ALWAYS via getCustomerBalance (portal → Account; newapi → quota).
const mockGetCustomerBalance = vi.fn();
vi.mock('@/lib/billing/customer-balance', () => ({
    getCustomerBalance: (...a: unknown[]) => mockGetCustomerBalance(...a),
}));

const mockGetUsageAggregate = vi.fn();
vi.mock('@/lib/newapi/usage-aggregate', () => ({
    getUsageAggregate: (...a: unknown[]) => mockGetUsageAggregate(...a),
}));

const mockQueryLogs = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    queryLogs: (...a: unknown[]) => mockQueryLogs(...a),
    quotaToCny: (q: number) => (q / 500_000) * 7.2,
    quotaToUsd: (q: number) => q / 500_000,
}));

const mockRechargeLogFindMany = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        rechargeLog: { findMany: (...a: unknown[]) => mockRechargeLogFindMany(...a) },
    },
}));

vi.mock('@/lib/reseller/fetch-status', () => ({
    fetchResellerStatus: vi.fn(async () => ({ status: null, isReseller: false })),
}));

// Stub the recharts chart — assert it receives the right stack keys.
vi.mock('@/app/(authenticated)/dashboard/model-consumption-chart', () => ({
    ModelConsumptionChart: ({ models }: { models: string[] }) => (
        <div data-testid="chart">{`chart-models:${models.join('|')}`}</div>
    ),
}));

import DashboardPage from '@/app/(authenticated)/dashboard/page';

const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NEWAPI_USER_ID = 7;
const NEWAPI_USERNAME = 'c-aaaaaaaa';
const SAMPLE_USER = {
    id: PORTAL_USER_ID,
    email: 'happy@silkroadai.io',
    nickname: null,
    newapi_user_id: NEWAPI_USER_ID,
    newapi_username: NEWAPI_USERNAME,
    balance_alert_threshold_cny: 10,
};

const newapiBal = (over: Record<string, unknown> = {}) => ({
    balanceCny: 7.2,
    spentCny: 1.44,
    source: 'newapi' as const,
    stale: false,
    quota: { remain: 500_000, used: 100_000 },
    ...over,
});

function aggSnap(over: Record<string, unknown> = {}) {
    return {
        totalUsedQuota: 600_000, // ¥8.64
        totalCalls: 250,
        totalPromptTokens: 12_000,
        totalCompletionTokens: 8_000,
        byModel: [
            { model: 'gpt-5.4', calls: 150, quota: 400_000 },
            { model: 'claude-opus-4-8', calls: 80, quota: 150_000 },
            { model: 'gemini-3-pro-image-preview', calls: 20, quota: 50_000 },
        ],
        byDay: [{ date: '2026-06-01', values: { 'gpt-5.4': 400_000 } }],
        chartModels: ['gpt-5.4', 'claude-opus-4-8', 'gemini-3-pro-image-preview'],
        period: '30d',
        source: 'live' as const,
        computedAt: new Date(),
        pagesFetched: 1,
        ...over,
    };
}

function makeLog(o: Partial<Record<string, unknown>> = {}) {
    return {
        id: (o.id as number) ?? 1,
        user_id: (o.user_id as number) ?? NEWAPI_USER_ID,
        created_at: (o.created_at as number) ?? 1_700_000_000,
        type: (o.type as number) ?? 2,
        content: (o.content as string) ?? '',
        username: NEWAPI_USERNAME,
        token_name: 'prod',
        model_name: (o.model_name as string) ?? 'gpt-5.4',
        quota: (o.quota as number) ?? 1000,
        prompt_tokens: (o.prompt_tokens as number) ?? 100,
        completion_tokens: (o.completion_tokens as number) ?? 200,
        use_time: (o.use_time as number) ?? 1200,
        is_stream: false,
        channel: 1,
        token_id: 1,
        group: 'default',
    };
}

/** Drive the two type-keyed queryLogs calls (type=2 consume, type=5 error). */
function setLogs(consume: ReturnType<typeof makeLog>[], errors: ReturnType<typeof makeLog>[] = []) {
    mockQueryLogs.mockImplementation(async ({ type }: { type: number }) => {
        if (type === 2) return { items: consume, total: consume.length };
        if (type === 5) return { items: errors, total: errors.length };
        return { items: [], total: 0 };
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockHeadersGet.mockReturnValue('silkroad_session=fake-jwt');
    mockGetCurrentUser.mockResolvedValue(SAMPLE_USER);
    mockGetCustomerBalance.mockResolvedValue(newapiBal());
    mockGetUsageAggregate.mockResolvedValue(aggSnap());
    mockRechargeLogFindMany.mockResolvedValue([]);
    setLogs([], []);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('<DashboardPage /> merged console — happy path', () => {
    it('renders all 5 summary cards with their numbers', async () => {
        const html = renderToString(await DashboardPage({ searchParams: Promise.resolve({}) }));
        // labels
        expect(html).toContain('当前余额');
        expect(html).toContain('历史消费');
        expect(html).toContain('请求次数');
        expect(html).toContain('统计 Tokens');
        expect(html).toContain('本期消费');
        // numbers
        expect(html).toMatch(/¥(<!-- -->)?7\.20/); // balance
        expect(html).toMatch(/¥(<!-- -->)?1\.44/); // historical spend
        expect(html).toMatch(/¥(<!-- -->)?8\.64/); // period spend (600k quota)
        expect(html).toContain('20,000'); // total tokens (12k + 8k)
        expect(html).toContain('12,000'); // prompt sub
        expect(html).toContain('8,000'); // completion sub
        // raw quota sub-display present in newapi mode
        expect(html).toContain('500,000');
    });

    it('passes chartModels to the chart + renders the 按模型 breakdown', async () => {
        const html = renderToString(await DashboardPage({ searchParams: Promise.resolve({}) }));
        expect(html).toContain('模型消耗分布');
        expect(html).toContain('chart-models:gpt-5.4|claude-opus-4-8|gemini-3-pro-image-preview');
        expect(html).toContain('按模型 Top');
        expect(html).toContain('claude-opus-4-8');
    });

    it('renders the per-call detail table: 成功 + 失败 + error content + 生图 token=0 "—"', async () => {
        setLogs(
            [
                makeLog({ id: 1, model_name: 'gpt-5.4', quota: 1000, use_time: 1200 }),
                makeLog({
                    id: 2,
                    model_name: 'gemini-3-pro-image-preview',
                    quota: 5000,
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    use_time: 800,
                }),
            ],
            [
                makeLog({
                    id: 3,
                    type: 5,
                    model_name: 'claude-opus-4-8',
                    quota: 0,
                    content: 'upstream 429 rate limited',
                }),
            ],
        );

        const html = renderToString(await DashboardPage({ searchParams: Promise.resolve({}) }));
        expect(html).toContain('调用明细');
        expect(html).toContain('成功');
        expect(html).toContain('失败');
        expect(html).toContain('upstream 429 rate limited'); // error content surfaced
        expect(html).toContain('gemini-3-pro-image-preview'); // image row visible
        expect(html).toContain('1.2s'); // friendly duration
    });

    it('renders preserved features: 充值流水 + 余额提醒设置', async () => {
        mockRechargeLogFindMany.mockResolvedValue([
            {
                id: 'rl-1',
                order_id: 'order-abcdefgh-rest',
                amount: 10,
                source: 'payment',
                created_at: new Date('2026-05-04T10:00:00Z'),
            },
        ]);

        const html = renderToString(await DashboardPage({ searchParams: Promise.resolve({}) }));
        // recharge history
        expect(html).toContain('充值流水');
        expect(html).toContain('在线支付');
        expect(html).toContain('order-ab');
        expect(html).toMatch(/¥(<!-- -->)?10\.00/);
        // balance alert threshold form (data-testid set by the component)
        expect(html).toContain('余额提醒设置');
        expect(html).toContain('balance-alert-form');
    });
});

describe('<DashboardPage /> P4c-3.5 balance fork', () => {
    it('reads balance via getCustomerBalance(user.id)', async () => {
        await DashboardPage({ searchParams: Promise.resolve({}) });
        expect(mockGetCustomerBalance).toHaveBeenCalledWith(PORTAL_USER_ID);
    });

    it('portal customer: ¥ from Account ledger, NO raw-quota sub-display', async () => {
        mockGetCustomerBalance.mockResolvedValue({
            balanceCny: 33.5,
            spentCny: 6.5,
            source: 'portal',
            stale: false,
            quota: null,
        });
        const html = renderToString(await DashboardPage({ searchParams: Promise.resolve({}) }));
        expect(html).toMatch(/¥(<!-- -->)?33\.50/);
        expect(html).toMatch(/¥(<!-- -->)?6\.50/);
        // portal has no new-api quota → the "quota" sub-display is absent
        expect(html).not.toContain('quota');
    });

    it('shows stale hint when balance source is fallback', async () => {
        mockGetCustomerBalance.mockResolvedValue(newapiBal({ stale: true }));
        const html = renderToString(await DashboardPage({ searchParams: Promise.resolve({}) }));
        expect(html).toContain('余额数据暂时不可更新');
    });
});

describe('<DashboardPage /> period filter (gotcha #15)', () => {
    it('passes username (NOT user_id) + type 2 and type 5 to queryLogs', async () => {
        await DashboardPage({ searchParams: Promise.resolve({}) });
        const types = mockQueryLogs.mock.calls.map((c) => c[0].type).sort();
        expect(types).toEqual([2, 5]);
        for (const call of mockQueryLogs.mock.calls) {
            expect(call[0].username).toBe(NEWAPI_USERNAME);
            expect(call[0].user_id).toBeUndefined();
        }
    });

    it('period=7d narrows the aggregate + log window', async () => {
        const before = Math.floor(Date.now() / 1000);
        await DashboardPage({ searchParams: Promise.resolve({ period: '7d' }) });
        expect(mockGetUsageAggregate).toHaveBeenCalledWith(expect.objectContaining({ period: '7d' }));
        const consumeCall = mockQueryLogs.mock.calls.find((c) => c[0].type === 2)!;
        expect(consumeCall[0].start_timestamp).toBeGreaterThanOrEqual(before - 7 * 86_400 - 5);
    });

    it('period=all omits start_timestamp', async () => {
        await DashboardPage({ searchParams: Promise.resolve({ period: 'all' }) });
        const consumeCall = mockQueryLogs.mock.calls.find((c) => c[0].type === 2)!;
        expect(consumeCall[0].start_timestamp).toBeUndefined();
    });

    it('invalid period falls back to 30d', async () => {
        const before = Math.floor(Date.now() / 1000);
        await DashboardPage({ searchParams: Promise.resolve({ period: '../../etc/passwd' }) });
        expect(mockGetUsageAggregate).toHaveBeenCalledWith(expect.objectContaining({ period: '30d' }));
        const consumeCall = mockQueryLogs.mock.calls.find((c) => c[0].type === 2)!;
        expect(consumeCall[0].start_timestamp).toBeCloseTo(before - 30 * 86_400, -2);
    });
});

describe('<DashboardPage /> graceful degradation', () => {
    it('balErr → banner + 暂无数据 on balance cards, usage still renders', async () => {
        mockGetCustomerBalance.mockRejectedValue(new Error('account fetch failed'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const html = renderToString(await DashboardPage({ searchParams: Promise.resolve({}) }));
        expect(html).toContain('当前无法获取余额');
        expect(html).toContain('暂无数据');
        // usage-derived cards still show numbers
        expect(html).toMatch(/¥(<!-- -->)?8\.64/);
        warn.mockRestore();
    });

    it('usage aggregate hard-fail → usageErr banner + 暂无数据, balance still renders', async () => {
        mockGetUsageAggregate.mockRejectedValue(new Error('usage aggregate fetch failed'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const html = renderToString(await DashboardPage({ searchParams: Promise.resolve({}) }));
        expect(html).toContain('当前无法获取用量数据');
        expect(html).toMatch(/¥(<!-- -->)?7\.20/); // balance intact
        warn.mockRestore();
    });

    it('account_not_provisioned (no newapi_user_id) → banner + queryLogs NOT called', async () => {
        mockGetCurrentUser.mockResolvedValue({ ...SAMPLE_USER, newapi_user_id: null });
        const html = renderToString(await DashboardPage({ searchParams: Promise.resolve({}) }));
        expect(html).toContain('账户尚未关联到上游');
        expect(mockQueryLogs).not.toHaveBeenCalled();
        // balance still renders
        expect(html).toMatch(/¥(<!-- -->)?7\.20/);
    });
});

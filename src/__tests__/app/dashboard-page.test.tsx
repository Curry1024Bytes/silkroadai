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
 *   - account balance feature panel + usage metric grid
 *   - 模型消耗分布 chart receives chartModels
 *   - 按模型 breakdown + per-call detail (成功/失败 + 生图 token=0)
 *   - period filter (queryLogs uses username NOT user_id, gotcha #15)
 *   - preserved features: 充值流水 + 余额提醒设置
 *   - graceful degradation: balErr / usageErr / account_not_provisioned
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { Writable } from 'node:stream';
import { renderToPipeableStream } from 'react-dom/server';

const mockHeadersGet = vi.fn<(name: string) => string | null>();
vi.mock('next/headers', () => ({
    headers: vi.fn(async () => ({ get: mockHeadersGet })),
}));

// PeriodTabs (real, rendered) is a client component using usePathname +
// useRouter(P2:useTransition + router.push 换掉 Link)。
vi.mock('next/navigation', () => ({
    usePathname: () => '/dashboard',
    useRouter: () => ({ push: vi.fn() }),
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

// i18n: default zh (matches the no-cookie site default); the English describe
// flips this to 'en'. Client islands read <LocaleProvider>, so the English
// render wraps the page in one — exactly what the root layout does in prod.
const mockLocale = vi.fn<() => Promise<'zh' | 'en'>>(async () => 'zh');
vi.mock('@/lib/i18n/server', () => ({
    getLocale: () => mockLocale(),
    getMessages: async (d: { zh: unknown; en: unknown }) => ((await mockLocale()) === 'en' ? d.en : d.zh),
}));

// P4c-3.5: balance/spend ALWAYS via getCustomerBalance (portal → Account; newapi → quota).
const mockGetCustomerBalance = vi.fn();
vi.mock('@/lib/billing/customer-balance', () => ({
    getCustomerBalance: (...a: unknown[]) => mockGetCustomerBalance(...a),
}));

const mockGetUsageAggregate = vi.fn();
vi.mock('@/lib/newapi/usage-aggregate', () => ({
    getUsageAggregate: (...a: unknown[]) => mockGetUsageAggregate(...a),
    // seedance-cn union 单独在 usage-aggregate.test 里测;这里透传不改聚合。
    unionSeedanceUsage: async (agg: unknown) => agg,
}));

const mockQueryLogs = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    queryLogs: (...a: unknown[]) => mockQueryLogs(...a),
    quotaToCny: (q: number) => (q / 500_000) * 7.2,
    quotaToUsd: (q: number) => q / 500_000,
}));

const mockRechargeLogFindMany = vi.fn();
const mockVideoMetadata = vi.fn();
const mockVideoTimings = vi.fn();
const mockVideoTasks = vi.fn<(...args: unknown[]) => Promise<Map<string, unknown>>>(async () => new Map());
vi.mock('@/lib/customer-video-tasks', () => ({
    readCustomerVideoTasks: (...args: unknown[]) => mockVideoTasks(...args),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        rechargeLog: { findMany: (...a: unknown[]) => mockRechargeLogFindMany(...a) },
        sdVideoTaskMetadata: { findMany: (...a: unknown[]) => mockVideoMetadata(...a) },
    },
}));
vi.mock('@/lib/sd-special-video-delivery', () => ({
    readSdSpecialTaskTimings: (...a: unknown[]) => mockVideoTimings(...a),
}));
vi.mock('@/lib/newapi/quota-units', async (load) => ({
    ...(await load<typeof import('@/lib/newapi/quota-units')>()),
    QUOTA_PER_USD: 500_000,
    USD_TO_CNY_RATE: 7.2,
}));

vi.mock('@/lib/reseller/fetch-status', () => ({
    fetchResellerStatus: vi.fn(async () => ({ status: null, isReseller: false })),
}));

// Stub the recharts chart — assert it receives the right stack keys.
// P2 起 sections.tsx 走懒加载壳(model-consumption-chart-lazy),mock 壳本身。
vi.mock('@/app/(authenticated)/dashboard/model-consumption-chart-lazy', () => ({
    ModelConsumptionChartLazy: ({ models }: { models: string[] }) => (
        <div data-testid="chart">{`chart-models:${models.join('|')}`}</div>
    ),
}));

import DashboardPage, { generateMetadata } from '@/app/(authenticated)/dashboard/page';
import { LocaleProvider } from '@/lib/i18n/client';
import { __resetLogsCacheForTest } from '@/lib/newapi/logs-cache';
import { loadUsageData } from '@/app/(authenticated)/dashboard/sections';

/** P1 streaming(2026-08-29):页面拆成 Suspense + async sections 后,
 *  renderToString 渲不动 async 组件 —— 改用 Fizz 流式渲染,onAllReady 时
 *  所有 Suspense 均已 resolve,拿到完整最终 HTML(原有断言语义不变)。 */
function renderFull(el: ReactNode): Promise<string> {
    return new Promise((resolve, reject) => {
        let html = '';
        const sink = new Writable({
            write(chunk, _enc, cb) {
                html += chunk;
                cb();
            },
        });
        sink.on('finish', () => resolve(html));
        const { pipe } = renderToPipeableStream(el, {
            onAllReady() {
                pipe(sink);
            },
            onError(err) {
                reject(err);
            },
        });
    });
}

async function renderPage(searchParams: Record<string, string | string[] | undefined> = {}) {
    return renderFull(await DashboardPage({ searchParams: Promise.resolve(searchParams) }));
}

const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NEWAPI_USER_ID = 7;
const NEWAPI_USERNAME = 'c-aaaaaaaa';
const SAMPLE_USER = {
    id: PORTAL_USER_ID,
    email: 'happy@llmroute.club',
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
        totalTokens: 20_000, // combined token_used from /api/data/
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
        token_name: (o.token_name as string) ?? 'prod',
        request_id: (o.request_id as string) ?? '20260705REQ00000000000000000000000000',
        model_name: (o.model_name as string) ?? 'gpt-5.4',
        // 计费口径:默认按 token(model_price=-1);生图按张的行显式传 model_price≥0 的 other。
        other: (o.other as string) ?? '{"model_price":-1,"model_ratio":2,"completion_ratio":4}',
        quota: (o.quota as number) ?? 1000,
        prompt_tokens: (o.prompt_tokens as number) ?? 100,
        completion_tokens: (o.completion_tokens as number) ?? 200,
        use_time: (o.use_time as number) ?? 2, // new-api 单位:秒
        is_stream: false,
        channel: 1,
        token_id: 1,
        group: 'default',
    };
}

/** Drive the type-keyed queryLogs calls (type=2 consume, type=5 error, type=6 refund). */
function setLogs(
    consume: ReturnType<typeof makeLog>[],
    errors: ReturnType<typeof makeLog>[] = [],
    refunds: ReturnType<typeof makeLog>[] = [],
) {
    mockQueryLogs.mockImplementation(async ({ type }: { type: number }) => {
        if (type === 2) return { items: consume, total: consume.length };
        if (type === 5) return { items: errors, total: errors.length };
        if (type === 6) return { items: refunds, total: refunds.length };
        return { items: [], total: 0 };
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    // dashboard 的日志明细走 logs-cache 的 30s 进程内缓存(2026-08-15)。
    // 缓存是模块级的,不清就会把上个用例的结果带进下个用例。
    __resetLogsCacheForTest();
    mockLocale.mockResolvedValue('zh');
    mockHeadersGet.mockReturnValue('silkroad_session=fake-jwt');
    mockGetCurrentUser.mockResolvedValue(SAMPLE_USER);
    mockGetCustomerBalance.mockResolvedValue(newapiBal());
    mockGetUsageAggregate.mockResolvedValue(aggSnap());
    mockRechargeLogFindMany.mockResolvedValue([]);
    mockVideoMetadata.mockResolvedValue([]);
    mockVideoTimings.mockResolvedValue(new Map());
    setLogs([], []);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('dashboard video log metadata', () => {
    const taskId = `task_${'x'.repeat(32)}`;
    const snapshot = {
        task_id: taskId,
        public_model: 'sd-2-mini',
        resolution: '480p',
        has_video: false,
        aspect_ratio: '16:9',
    };
    const args = {
        portalUserId: PORTAL_USER_ID,
        newapiUserId: NEWAPI_USER_ID,
        newapiUsername: NEWAPI_USERNAME,
        period: '30d' as const,
    };
    const sdLog = () =>
        makeLog({
            model_name: 'sd-2-mini-480-novideo',
            quota: 250_000,
            use_time: 3,
            other: JSON.stringify({
                is_task: true,
                billing_mode: 'tiered_expr',
                task_id: taskId,
                usage_facts: { seconds: 4 },
                matched_tier: 'seconds',
                group_ratio: 1,
                expr_b64: Buffer.from('tier("seconds", u("seconds") * 0.125)').toString('base64'),
            }),
        });

    it('uses public SD names and owner-scoped specs/timings without changing the charge or aggregate', async () => {
        const aggregate = aggSnap();
        mockGetUsageAggregate.mockResolvedValue(aggregate);
        mockVideoMetadata.mockResolvedValue([snapshot]);
        mockVideoTimings.mockResolvedValue(new Map([[taskId, { model: 'sd-2-mini', elapsedSec: 207 }]]));
        setLogs([
            sdLog(),
            { ...sdLog(), id: 2, user_id: 999, other: sdLog().other.replace(taskId, `task_${'y'.repeat(32)}`) },
        ]);
        const data = await loadUsageData(args);
        expect(data.calls).toHaveLength(1);
        expect(data.calls[0]).toMatchObject({
            model: 'sd-2-mini',
            costCny: 3.6,
            quota: 250_000,
            video: { resolution: '480p', videoInput: 'none', ratio: '16:9', elapsedSec: 207, unitCnyPerSecond: 0.9 },
        });
        expect(mockVideoMetadata.mock.calls[0][0].where).toEqual({
            user_id: PORTAL_USER_ID,
            task_id: { in: [taskId] },
        });
        expect(mockVideoTimings).toHaveBeenCalledExactlyOnceWith(NEWAPI_USER_ID, [taskId]);
        expect(data.agg).toBe(aggregate);
        const html = await renderPage();
        expect(html).toContain('480p · 无参考视频 · 4 秒');
        expect(html).toContain('3m 27s');
        expect(html).not.toContain('sd-2-mini-480-novideo');
    });

    it('enriches historical task time without inventing an unrecorded aspect ratio', async () => {
        mockVideoTimings.mockResolvedValue(new Map([[taskId, { model: 'sd-2-mini', elapsedSec: 207 }]]));
        setLogs([sdLog()]);
        const data = await loadUsageData(args);
        expect(data.calls[0].video).toMatchObject({ elapsedSec: 207, ratio: null });
    });

    it.each(['snapshot', 'timing', 'both'])(
        'degrades %s lookup failures without losing charges or totals',
        async (failed) => {
            const aggregate = aggSnap();
            mockGetUsageAggregate.mockResolvedValue(aggregate);
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            mockVideoMetadata.mockResolvedValue([snapshot]);
            mockVideoTimings.mockResolvedValue(new Map([[taskId, { model: 'sd-2-mini', elapsedSec: 207 }]]));
            if (failed !== 'timing') mockVideoMetadata.mockRejectedValue(new Error('metadata unavailable'));
            if (failed !== 'snapshot') mockVideoTimings.mockRejectedValue(new Error('task timing unavailable'));
            setLogs([sdLog()]);
            const data = await loadUsageData(args);
            expect(data.usageErr).toBeNull();
            expect(data.agg).toBe(aggregate);
            expect(data.calls[0]).toMatchObject({
                model: 'sd-2-mini',
                costCny: 3.6,
                video: { ratio: failed === 'timing' ? '16:9' : null, elapsedSec: failed === 'snapshot' ? 207 : null },
            });
        },
    );

    it.each([
        { type: 2, tokens: 10_000, actual: 50_000, phase: 'settle_extra', cost: 0.144 },
        { type: 6, tokens: 6_000, actual: 30_000, phase: 'settle_refund', cost: -0.144 },
    ])(
        'shows official $phase with task timing independent of a missing estimate and preserves signed amounts',
        async ({ type, tokens, actual, phase, cost }) => {
            const other = {
                is_task: true,
                billing_mode: 'tiered_expr',
                task_id: `task_${'o'.repeat(32)}`,
                usage_facts: { tokens: 8_000, resolution: '480p', video_input: 'none' },
                matched_tier: '480p·none',
                group_ratio: 1,
                expr_b64: Buffer.from('tier("480p·none", u("tokens") * 10 / 1000000)').toString('base64'),
            };
            const estimate = makeLog({
                model_name: 'doubao-seedance-2-5-260628',
                quota: 40_000,
                other: JSON.stringify(other),
            });
            const settlement = {
                ...estimate,
                id: 2,
                type,
                created_at: estimate.created_at + 311,
                quota: 10_000,
                prompt_tokens: 0,
                completion_tokens: 0,
                other: JSON.stringify({
                    ...other,
                    usage_facts: { ...other.usage_facts, tokens },
                    pre_consumed_quota: 40_000,
                    actual_quota: actual,
                }),
            };
            mockVideoTasks.mockResolvedValue(
                new Map([
                    [
                        other.task_id,
                        {
                            model: estimate.model_name,
                            display: { elapsedSec: 311, status: 'completed', outputSeconds: 5, request: {} },
                        },
                    ],
                ]),
            );
            setLogs(type === 2 ? [settlement] : [], [], type === 6 ? [settlement] : []);
            const data = await loadUsageData(args);
            expect(data.calls[0].costCny).toBeCloseTo(cost, 12);
            expect(data.calls[0]).toMatchObject({
                video: { phase, billingUnit: 'tokens', tokens, unitCnyPer1M: 72, elapsedSec: 311 },
            });
            expect(data.calls).toHaveLength(1);
            const html = await renderPage();
            expect(html).toContain(`0 / ${tokens.toLocaleString('en-US')}`);
            expect(html).toContain('5m 11s');
            expect(mockVideoTimings).not.toHaveBeenCalled();
        },
    );

    it('keeps a matched failed SD task at zero cost without exposing a successful billing detail', async () => {
        const charge = sdLog();
        setLogs([charge], [], [{ ...charge, id: 2, type: 6, created_at: charge.created_at + 100 }]);
        const data = await loadUsageData(args);
        expect(data.calls).toHaveLength(1);
        expect(data.calls[0]).toMatchObject({ model: 'sd-2-mini', type: 6, costCny: 0, video: null });
        expect(mockVideoMetadata).not.toHaveBeenCalled();
        expect(mockVideoTimings).not.toHaveBeenCalled();
    });

    it('does not query SD metadata for ordinary text and image rows', async () => {
        setLogs([makeLog(), makeLog({ id: 2, model_name: 'gpt-image-2' })]);
        const data = await loadUsageData(args);
        expect(data.calls).toHaveLength(2);
        expect(data.calls.every((row) => row.video === null)).toBe(true);
        expect(mockVideoMetadata).not.toHaveBeenCalled();
        expect(mockVideoTimings).not.toHaveBeenCalled();
    });
});

describe('<DashboardPage /> merged console — happy path', () => {
    it('renders all 5 summary cards with their numbers', async () => {
        const html = await renderPage({});
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
        // total tokens 20,000 → compact "20.0K" headline + exact "20,000" in the subline
        expect(html).toContain('20.0');
        expect(html).toContain('20,000');
        expect(html).toContain('输入+输出'); // token card subline (no per-side split from /api/data/)
        // Customer-facing balance uses RMB only; internal quota units stay hidden.
        // 2026-10-22: raw new-api quota is an internal unit — no longer shown to customers
        expect(html).not.toContain('500,000');
        expect(html).not.toContain('quota');
    });

    it('passes chartModels to the chart + renders the 热门模型 breakdown', async () => {
        const html = await renderPage({});
        expect(html).toContain('模型消耗分布');
        expect(html).toContain('chart-models:gpt-5.4|claude-opus-4-8|gemini-3-pro-image-preview');
        expect(html).toContain('热门模型');
        expect(html).toContain('claude-opus-4-8');
    });

    it('renders the per-call detail table: 成功 + 失败 + error content + 生图 token=0 "—"', async () => {
        setLogs(
            [
                // 非生图:默认 token 100/200,use_time 3 秒 → "3s"
                makeLog({
                    id: 1,
                    model_name: 'gpt-5.4',
                    quota: 1000,
                    use_time: 3,
                    token_name: 'prod-openai',
                    request_id: '20260705REQ-consume-0001',
                }),
                makeLog({
                    id: 2,
                    model_name: 'gemini-3-pro-image-preview',
                    quota: 5000,
                    // 按张计费(model_price 设值)→ 上游噪声 token(1212/1105)应被隐藏成 "—"
                    other: '{"model_price":0.06429,"model_ratio":0}',
                    prompt_tokens: 1212,
                    completion_tokens: 1105,
                    use_time: 56, // 秒 → 应显示 "56s"(不是 "56ms")
                }),
                makeLog({
                    id: 4,
                    model_name: 'gpt-image-2',
                    quota: 3928,
                    // 按 token 计费(model_price=-1,ModelRatio)→ token 是计费依据,必须如实显示
                    other: '{"model_price":-1,"model_ratio":0.9285714285714286,"completion_ratio":6}',
                    prompt_tokens: 3054,
                    completion_tokens: 196,
                }),
            ],
            [
                makeLog({
                    id: 3,
                    type: 5,
                    model_name: 'claude-opus-4-8',
                    quota: 0,
                    request_id: '20260705REQ-error-0003', // 独立 request_id → 真失败,不被折叠
                    content: 'upstream 429 rate limited',
                }),
            ],
        );

        const html = await renderPage({});
        expect(html).toContain('调用明细');
        expect(html).toContain('成功');
        expect(html).toContain('失败');
        expect(html).toContain('服务繁忙'); // 错误文案脱敏 + 友好化(upstream 429 → 服务繁忙,不泄露上游)
        expect(html).toContain('gemini-3-pro-image-preview'); // image row visible
        // 时长:use_time 是秒,56 秒 → "56s"(回归:曾经被当 ms 错显示成 "56ms")
        expect(html).toContain('56s');
        // 按张计费的生图(gemini)token 一律 "—",不显示误导的原始 token 数
        expect(html).not.toContain('1,212 / 1,105');
        // 按 token 计费的生图(gpt-image-2)如实显示 token —— 客户被计费的依据
        expect(html).toContain('3,054 / 196');
        // 非生图模型 token 正常显示
        expect(html).toContain('100 / 200');
        // 客户要的两列:哪个 key(token_name)+ request id 逐行透传到明细表
        expect(html).toContain('prod-openai');
        expect(html).toContain('20260705REQ-consume-0001');
    });

    it('renders settlement refund as a negative 结算退款 row, separate from failed-task matching', async () => {
        setLogs(
            [makeLog({ id: 1, model_name: 'doubao-seedance-2-0-mini-260615', quota: 5000 })],
            [],
            [
                makeLog({
                    id: 2,
                    type: 6,
                    model_name: 'doubao-seedance-2-0-mini-260615',
                    quota: 5000,
                    created_at: 1_700_000_010,
                    other: '{"task_id":"task_1","pre_consumed_quota":50000,"actual_quota":45000}',
                    content: '任务用量表达式结算',
                }),
            ],
        );
        const html = await renderPage({});
        expect(html).toContain('结算退款');
        expect(html).toContain('-¥0.072');
        expect(html).not.toContain('¥-');
        expect(html).toContain('预扣 ¥0.72');
        expect(html).not.toContain('视频任务未生成成功');
    });

    it('renders a failed video (failure refund matched to its charge) as 失败 ¥0 with the refund note', async () => {
        setLogs(
            [makeLog({ id: 1, model_name: 'doubao-seedance-2-0-mini-260615', quota: 5000 })],
            [],
            [
                makeLog({
                    id: 2,
                    type: 6,
                    model_name: 'doubao-seedance-2-0-mini-260615',
                    quota: 5000,
                    created_at: 1_700_000_010,
                    other: '{"task_id":"task_2","reason":"task failed"}',
                    content: '',
                }),
            ],
        );
        const html = await renderPage({});
        expect(html).toContain('视频任务未生成成功,已自动退还本次预扣费用');
        expect(html).toContain('失败');
        expect(html).not.toContain('结算退款');
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

        const html = await renderPage({});
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
        const html = await renderPage({});
        expect(html).toMatch(/¥(<!-- -->)?33\.50/);
        expect(html).toMatch(/¥(<!-- -->)?6\.50/);
        // portal has no new-api quota → the "quota" sub-display is absent
        expect(html).not.toContain('quota');
    });

    it('shows stale hint when balance source is fallback', async () => {
        mockGetCustomerBalance.mockResolvedValue(newapiBal({ stale: true }));
        const html = await renderPage({});
        expect(html).toContain('余额数据暂时不可更新');
    });
});

describe('<DashboardPage /> period filter (gotcha #15)', () => {
    it('passes username (NOT user_id) + type 2, 5, 6 to queryLogs', async () => {
        await DashboardPage({ searchParams: Promise.resolve({}) });
        const types = mockQueryLogs.mock.calls.map((c) => c[0].type).sort();
        expect(types).toEqual([2, 5, 6]); // 2=consume 5=error 6=视频退款(失败退款或结算退款)
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
        const html = await renderPage({});
        expect(html).toContain('当前无法获取余额');
        expect(html).toContain('暂无数据');
        // usage-derived cards still show numbers
        expect(html).toMatch(/¥(<!-- -->)?8\.64/);
        warn.mockRestore();
    });

    it('usage aggregate hard-fail → usageErr banner + 暂无数据, balance still renders', async () => {
        mockGetUsageAggregate.mockRejectedValue(new Error('usage aggregate fetch failed'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const html = await renderPage({});
        expect(html).toContain('当前无法获取用量数据');
        expect(html).toMatch(/¥(<!-- -->)?7\.20/); // balance intact
        warn.mockRestore();
    });

    it('account_not_provisioned (no newapi_user_id) → banner + queryLogs NOT called', async () => {
        mockGetCurrentUser.mockResolvedValue({ ...SAMPLE_USER, newapi_user_id: null });
        const html = await renderPage({});
        expect(html).toContain('账户尚未关联到上游');
        expect(mockQueryLogs).not.toHaveBeenCalled();
        // balance still renders
        expect(html).toMatch(/¥(<!-- -->)?7\.20/);
    });
});

describe('<DashboardPage /> compact stat numbers (2026-10-22, 头部客户量级)', () => {
    it('compacts ¥ ≥ 10万 to 万 and keeps the exact value in the subline', async () => {
        mockGetCustomerBalance.mockResolvedValue(newapiBal({ balanceCny: 290_262.82, spentCny: 1_215_773.1 }));
        const html = await renderPage({});
        // 当前余额 ¥290,262.82 → headline "29.03" + "万", exact in subline; LLmRoute retains RMB-only balance display
        expect(html).toContain('29.03');
        expect(html).toContain('万');
        expect(html).toContain('¥290,262.82');
        expect(html).not.toContain('$40,314.28'); // LLmRoute: do not reintroduce USD balance display
        // 历史消费 ¥1,215,773.10 → "121.58 万"
        expect(html).toContain('121.58');
        expect(html).toContain('¥1,215,773.10');
        // the ten-digit raw strings must not appear as headline text
        expect(html).not.toMatch(/¥(<!-- -->)?290262\.82/);
        expect(html).not.toContain('quota');
    });

    it('compacts tokens to B / calls to 万 with exact values in the subline', async () => {
        mockGetUsageAggregate.mockResolvedValue(
            aggSnap({ totalTokens: 1_000_719_906, totalCalls: 2_184_903, totalUsedQuota: 74_146_775_000 }),
        );
        const html = await renderPage({});
        expect(html).toContain('1.00');
        expect(html).toContain('>B<');
        expect(html).toContain('1,000,719,906');
        expect(html).toContain('218.5');
        expect(html).toMatch(/2,184,903(<!-- -->)? 次/);
        // headline never shows the full comma-separated ten-digit token count
        expect(html).not.toMatch(/text-3xl[^<]*>1,000,719,906/);
    });

    it('leaves small-customer numbers uncompacted (threshold guard)', async () => {
        const html = await renderPage({});
        // defaults: ¥7.20 / ¥1.44 / 250 calls / 20,000 tokens → 20.0K
        expect(html).toMatch(/¥(<!-- -->)?7\.20/);
        expect(html).toMatch(/¥(<!-- -->)?1\.44/);
        expect(html).toContain('250');
        expect(html).not.toContain('万');
        expect(html).toContain('>K<');
    });
});

describe('<DashboardPage /> English locale', () => {
    async function renderEn(searchParams: Record<string, string> = {}) {
        mockLocale.mockResolvedValue('en');
        const page = await DashboardPage({ searchParams: Promise.resolve(searchParams) });
        return renderFull(<LocaleProvider locale="en">{page}</LocaleProvider>);
    }

    it('renders the shell, cards, tabs and recharge history in English (no Chinese UI strings)', async () => {
        mockRechargeLogFindMany.mockResolvedValue([
            { id: 'rl-1', order_id: 'order-abcdefgh', amount: 10, source: 'payment', created_at: new Date() },
        ]);
        const html = await renderEn();
        expect(html).toContain('Welcome, happy');
        expect(html).toContain('Current balance');
        expect(html).toContain('Total spend');
        expect(html).toContain('Requests');
        expect(html).toContain('Spend this period');
        expect(html).toContain('Last 30 days'); // PeriodTabs (client island via LocaleProvider)
        expect(html).toContain('Spend by model · Last 30 days');
        expect(html).toContain('Request details · Last 30 days');
        expect(html).toContain('Top-up history');
        expect(html).toContain('Online payment');
        expect(html).toContain('Low-balance alert');
        expect(html).toContain('Top up');
        for (const zh of ['当前余额', '历史消费', '请求次数', '本期消费', '充值流水', '近 30 天', '余额提醒设置']) {
            expect(html, zh).not.toContain(zh);
        }
    });

    it('per-call table + sanitized error copy follow the locale', async () => {
        setLogs(
            [makeLog({ id: 1 })],
            [makeLog({ id: 3, type: 5, quota: 0, request_id: 'REQ-err', content: 'upstream 429 rate limited' })],
        );
        const html = await renderEn();
        expect(html).toContain('Success');
        expect(html).toContain('Failed');
        expect(html).toContain('Service busy'); // sanitizeLogContent(…, 'en')
        expect(html).not.toContain('服务繁忙');
        expect(html).toContain('Tokens (prompt / completion)');
    });

    it('compacts big ¥ / counts with K / M instead of 万 in English', async () => {
        mockGetCustomerBalance.mockResolvedValue(newapiBal({ balanceCny: 290_262.82, spentCny: 1_215_773.1 }));
        mockGetUsageAggregate.mockResolvedValue(aggSnap({ totalCalls: 2_184_903 }));
        const html = await renderEn();
        expect(html).toContain('290.26');
        expect(html).toContain('>K<');
        expect(html).toContain('1.22');
        expect(html).toContain('>M<');
        expect(html).toMatch(/2,184,903(<!-- -->)? requests/);
        expect(html).not.toContain('万');
    });

    it('generateMetadata follows the locale', async () => {
        mockLocale.mockResolvedValue('en');
        expect(await generateMetadata()).toEqual({ title: 'Overview — LLmRoute' });
        mockLocale.mockResolvedValue('zh');
        expect(await generateMetadata()).toEqual({ title: '概览 — LLmRoute' });
    });
});

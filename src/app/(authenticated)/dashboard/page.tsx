/**
 * /dashboard — 客户控制台三合一 (overview + balance + usage on one page,
 * new-api 看板 风格). Replaces the separate /balance + /usage pages, which now
 * 307-redirect here.
 *
 * Sections (all in one scroll, period tabs drive the period-scoped ones):
 *   1. 汇总卡 ×5    — 当前余额 / 历史消费 / 请求次数 / 统计 Tokens / 本期消费
 *   2. 模型消耗分布 — recharts stacked bar by model over time (ModelConsumptionChart)
 *   3. 按模型 Top N — per-model % breakdown (preserved from /usage)
 *   4. 调用明细     — per-call table: 时间/模型/时长/token/¥/结果 (CallDetailTable) — the
 *                     customer's core ask; pulls type=2 (成功) + type=5 (失败) merged
 *   5. 余额提醒设置 — threshold form (preserved from /balance)
 *   6. 充值流水     — recharge history (preserved from /balance)
 *   7. 代理推广卡   — reseller promo (preserved from old /dashboard)
 *
 * ⚠️ Balance/spend ALWAYS go through getCustomerBalance (P4c-3.5 fork: portal
 *    mode reads Account ¥ ledger, newapi mode reads quota). Never read new-api
 *    quota directly as balance.
 *
 * Resilience: balance, the usage aggregate, and the per-call log fetches are
 * independent — one failing degrades only its own section (暂无数据 / empty
 * state), never the whole page.
 */
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { getCustomerBalance, type CustomerBalance } from '@/lib/billing/customer-balance';
import { getUsageAggregate, type UsageAggregateSnapshot } from '@/lib/newapi/usage-aggregate';
import { queryLogs, quotaToCny, type NewApiUsageLog } from '@/lib/newapi/client';
import { USD_TO_CNY_RATE } from '@/lib/newapi/quota-units';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormError } from '@/components/ui/FormError';
import { fetchResellerStatus } from '@/lib/reseller/fetch-status';
import { ResellerPromoCard } from '@/components/reseller/ResellerPromoCard';
import { parsePeriod, periodToRange, type UsagePeriod } from './period';
import { PeriodTabs } from './period-tabs';
import { BalanceAlertForm } from './balance-alert-form';
import { ModelConsumptionChart } from './model-consumption-chart';
import { CallDetailTable, type CallRow } from './call-detail-table';
import { matchFailedVideoConsumes } from './failed-video-match';
import { collapseRetriedFailures, sanitizeLogContent } from './format';

export const dynamic = 'force-dynamic';
export const metadata = { title: '概览 — Silk Road AI' };

/** Recent-call fetch sizes for the detail table. The full-period TOTALS come
 *  from the aggregator (up to 50k rows); these two slices are only for the
 *  "每次调用明细" rows, so a bounded recent window keeps the render fast.
 *  Errors (type=5) are rarer, so a smaller slice. The merged list is capped
 *  at CALLS_CAP — paginated client-side in CallDetailTable. */
const CONSUME_FETCH_SIZE = 150;
const ERROR_FETCH_SIZE = 50;
const TASKFAIL_FETCH_SIZE = 50; // type=6 视频任务失败(退款)记录,用于把对应 type=2 行标成失败·已退款
const CALLS_CAP = 200;
const HISTORY_LIMIT = 10;
const TOP_MODELS = 5;

const PERIOD_LABEL: Record<UsagePeriod, string> = { '7d': '近 7 天', '30d': '近 30 天', all: '全部' };

const RECHARGE_SOURCE_LABEL: Record<string, string> = {
    payment: '在线支付',
    manual: '管理员充值',
    refund: '退款',
    promo: '推广奖励',
    adjustment: '余额调整',
};

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/dashboard', { method: 'GET', headers: { cookie } });
    return getCurrentUser(req);
}

function toCallRow(log: NewApiUsageLog): CallRow {
    return {
        id: log.id,
        createdAt: log.created_at,
        model: log.model_name,
        // 哪个 key(token 别名)+ request id — 客户排障定位句柄
        tokenName: log.token_name,
        requestId: log.request_id,
        // new-api `use_time` 单位是【秒】,×1000 转 ms(formatDuration 收 ms)。
        // 不转的话 56 秒的生图会显示成 "56ms"。
        useTimeMs: log.use_time * 1000,
        promptTokens: log.prompt_tokens,
        completionTokens: log.completion_tokens,
        quota: log.quota,
        // Compute ¥ here (server) where NEWAPI_QUOTA_PER_USD/USD_TO_CNY_RATE are
        // available — CallDetailTable is a client island and must not convert.
        costCny: quotaToCny(log.quota),
        type: log.type,
        content: sanitizeLogContent(log.content),
    };
}

/** A summary stat card (label + body). Body decides its own empty state. */
function StatCard({ label, children }: { label: string; children: ReactNode }) {
    return (
        <Card as="article">
            <CardHeader>
                <CardTitle as="h3" className="text-sm font-medium text-muted-ink">
                    {label}
                </CardTitle>
            </CardHeader>
            <CardContent>{children}</CardContent>
        </Card>
    );
}

const BIG = 'm-0 text-2xl font-semibold text-navy tabular-nums';
const SUB = 'mt-1.5 m-0 text-xs text-minor-ink tabular-nums';
const NO_DATA = <p className="m-0 text-sm text-minor-ink">暂无数据</p>;

export default async function DashboardPage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
    const user = await getSessionUser();
    // Layout already gated; this is just TS narrowing.
    if (!user) return null;

    const params = (await searchParams) ?? {};
    const period = parsePeriod(params.period);
    const range = periodToRange(period);
    const periodLabel = PERIOD_LABEL[period];

    // ── Balance (P4c-3.5 fork — never read quota directly) ──
    let bal: CustomerBalance | null = null;
    let balErr = false;
    try {
        bal = await getCustomerBalance(user.id);
    } catch (err) {
        balErr = true;
        console.warn(`[dashboard] getCustomerBalance failed for user ${user.id}:`, err);
    }

    // ── Usage aggregate + per-call logs (period-scoped) ──
    const newapiUserId = user.newapi_user_id;
    const newapiUsername = user.newapi_username;
    let agg: UsageAggregateSnapshot | null = null;
    let usageErr: 'account_not_provisioned' | 'fetch_failed' | null = null;
    let calls: CallRow[] = [];

    if (newapiUserId == null || newapiUsername == null) {
        usageErr = 'account_not_provisioned';
    } else {
        // username is the dimension new-api honors under admin auth (gotcha
        // #15 — user_id is silently dropped); we still post-filter every row
        // by user_id for defence-in-depth. type=2 (成功) + type=5 (失败) are
        // fetched separately, then merged + sorted desc for the detail table.
        const [aggSettled, consumeSettled, errorSettled, taskFailSettled] = await Promise.allSettled([
            getUsageAggregate({ portalUserId: user.id, newapiUserId, newapiUsername, period }),
            queryLogs({
                username: newapiUsername,
                type: 2,
                start_timestamp: range.start || undefined,
                end_timestamp: range.end,
                page: 1,
                page_size: CONSUME_FETCH_SIZE,
            }),
            queryLogs({
                username: newapiUsername,
                type: 5,
                start_timestamp: range.start || undefined,
                end_timestamp: range.end,
                page: 1,
                page_size: ERROR_FETCH_SIZE,
            }),
            queryLogs({
                username: newapiUsername,
                type: 6, // 视频异步任务失败 → 退还预扣 quota;用来把对应 type=2 消费标成失败·已退款
                start_timestamp: range.start || undefined,
                end_timestamp: range.end,
                page: 1,
                page_size: TASKFAIL_FETCH_SIZE,
            }),
        ]);

        if (aggSettled.status === 'fulfilled') {
            agg = aggSettled.value;
        } else {
            usageErr = 'fetch_failed';
            console.warn(`[dashboard] getUsageAggregate failed for user ${user.id}:`, aggSettled.reason);
        }

        const consume =
            consumeSettled.status === 'fulfilled'
                ? consumeSettled.value.items.filter((l) => l.user_id === newapiUserId && l.type === 2)
                : [];
        const errors =
            errorSettled.status === 'fulfilled'
                ? errorSettled.value.items.filter((l) => l.user_id === newapiUserId && l.type === 5)
                : [];
        const taskFailed =
            taskFailSettled.status === 'fulfilled'
                ? taskFailSettled.value.items.filter((l) => l.user_id === newapiUserId && l.type === 6)
                : [];
        if (consumeSettled.status === 'rejected') {
            console.warn(`[dashboard] consume queryLogs failed for user ${user.id}:`, consumeSettled.reason);
        }
        if (errorSettled.status === 'rejected') {
            console.warn(`[dashboard] error queryLogs failed for user ${user.id}:`, errorSettled.reason);
        }
        // 视频异步任务失败(type=6)会退还预扣费用(净扣 0)。把对应的 type=2 消费标成失败·已退款,
        // 否则明细表会把失败任务错显示成「成功 ¥X」(客户以为没出片还被扣钱)。
        const failedConsumeIds = matchFailedVideoConsumes(consume, taskFailed);
        // 折叠"失败了但重试 / failover 成功"的中间失败行(见 collapseRetriedFailures)——
        // 否则客户日志被 429/上游饱和这类中间过程刷屏,主观以为出了大问题。真失败(内容拒绝等)照常显示。
        const visibleErrors = collapseRetriedFailures(consume, errors);
        calls = [...consume, ...visibleErrors]
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, CALLS_CAP)
            .map((l) => {
                const row = toCallRow(l);
                if (failedConsumeIds.has(l.id)) {
                    row.type = 6; // → callResult 判失败
                    row.costCny = 0; // 已退款,本次不计费
                    row.content = '视频任务未生成成功,已自动退还本次预扣费用(未实际扣费)。';
                }
                return row;
            });
    }

    // ── Recharge history + reseller promo gate (preserved features) ──
    const history = await prisma.rechargeLog.findMany({
        where: { user_id: user.id },
        orderBy: { created_at: 'desc' },
        take: HISTORY_LIMIT,
        select: { id: true, order_id: true, amount: true, source: true, created_at: true },
    });
    const resellerSnap = await fetchResellerStatus(user.id);

    const byModel = agg ? agg.byModel.slice(0, TOP_MODELS) : [];
    const totalTokens = agg ? agg.totalTokens : 0;

    return (
        <section>
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="m-0 mb-2 text-2xl font-semibold text-navy">
                        欢迎,{user.nickname || user.email.split('@')[0]}
                    </h1>
                    <p className="m-0 text-sm text-muted-ink">余额、用量与每次调用明细,都在这里。</p>
                </div>
                <div className="flex items-center gap-3">
                    <PeriodTabs active={period} />
                    <Button href="/pay" size="sm">
                        + 充值
                    </Button>
                </div>
            </div>

            {bal?.stale && (
                <div
                    role="status"
                    className="mb-4 rounded-lg border border-status-warning-border bg-status-warning-bg px-4 py-2.5 text-xs text-status-warning-text"
                >
                    余额数据暂时不可更新,显示的是稍早数据。
                </div>
            )}
            {balErr && (
                <div className="mb-4">
                    <FormError severity="banner">当前无法获取余额,请稍后重试。</FormError>
                </div>
            )}

            {/* 1. Summary cards */}
            <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
                <StatCard label="当前余额">
                    {bal ? (
                        <>
                            <p className={BIG}>¥{bal.balanceCny.toFixed(2)}</p>
                            <p className={SUB}>
                                ≈ ${(bal.balanceCny / USD_TO_CNY_RATE).toFixed(2)} USD
                                {bal.quota && <> · {bal.quota.remain.toLocaleString('en-US')} quota</>}
                            </p>
                        </>
                    ) : (
                        NO_DATA
                    )}
                </StatCard>
                <StatCard label="历史消费">
                    {bal ? (
                        <>
                            <p className={BIG}>¥{bal.spentCny.toFixed(2)}</p>
                            <p className={SUB}>累计</p>
                        </>
                    ) : (
                        NO_DATA
                    )}
                </StatCard>
                <StatCard label="请求次数">
                    {agg ? (
                        <>
                            <p className={BIG}>{agg.totalCalls.toLocaleString('en-US')}</p>
                            <p className={SUB}>{periodLabel}</p>
                        </>
                    ) : (
                        NO_DATA
                    )}
                </StatCard>
                <StatCard label="统计 Tokens">
                    {agg ? (
                        <>
                            <p className={BIG}>{totalTokens.toLocaleString('en-US')}</p>
                            <p className={SUB}>{periodLabel} · 输入+输出</p>
                        </>
                    ) : (
                        NO_DATA
                    )}
                </StatCard>
                <StatCard label="本期消费">
                    {agg ? (
                        <>
                            <p className={BIG}>¥{quotaToCny(agg.totalUsedQuota).toFixed(2)}</p>
                            <p className={SUB}>
                                {periodLabel}
                                {agg.source === 'fallback' && ' · 数据稍滞后'}
                            </p>
                        </>
                    ) : (
                        NO_DATA
                    )}
                </StatCard>
            </div>

            {usageErr && (
                <div className="mb-6">
                    <FormError severity="banner">
                        {usageErr === 'account_not_provisioned'
                            ? '账户尚未关联到上游,请联系管理员。'
                            : '当前无法获取用量数据,请稍后重试。'}
                    </FormError>
                </div>
            )}

            {/* 2. Model consumption chart */}
            <h2 className="m-0 mb-3 text-base font-semibold text-navy">模型消耗分布 · {periodLabel}</h2>
            <div className="mb-6">
                <ModelConsumptionChart
                    byDay={agg?.byDay ?? []}
                    models={agg?.chartModels ?? []}
                    cnyPerQuota={quotaToCny(1)}
                />
            </div>

            {/* 3. By-model breakdown (preserved from /usage) */}
            {byModel.length > 0 && (
                <>
                    <h2 className="m-0 mb-3 text-base font-semibold text-navy">按模型 Top {byModel.length}</h2>
                    <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {byModel.map((m) => {
                            const pct = agg && agg.totalUsedQuota ? (m.quota / agg.totalUsedQuota) * 100 : 0;
                            return (
                                <Card as="article" key={m.model} className="px-4 py-3">
                                    <p
                                        className="m-0 mb-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm font-semibold text-navy"
                                        title={m.model}
                                    >
                                        {m.model}
                                    </p>
                                    <p className="m-0 mb-2 text-xs text-muted-ink tabular-nums">
                                        {m.calls.toLocaleString('en-US')} 次 · ¥{quotaToCny(m.quota).toFixed(2)} ·{' '}
                                        {pct.toFixed(1)}%
                                    </p>
                                    <div className="h-1.5 overflow-hidden rounded-sm bg-paper-muted">
                                        <div
                                            className="h-full bg-brand-accent"
                                            style={{ width: `${Math.max(2, pct)}%` }}
                                        />
                                    </div>
                                </Card>
                            );
                        })}
                    </div>
                </>
            )}

            {/* 4. Per-call detail table (core ask) */}
            <div className="mb-3 flex items-end justify-between gap-3">
                <h2 className="m-0 text-base font-semibold text-navy">调用明细 · {periodLabel}</h2>
                <a href="/logs" className="shrink-0 text-xs font-medium text-navy no-underline hover:underline">
                    查看全部日志 →
                </a>
            </div>
            <p className="m-0 mb-3 text-xs text-muted-ink">
                每行一次调用,含模型、时长、token 与消耗;失败的调用可展开查看错误详情。完整日志(按日期 + Request ID /
                令牌 / 模型 / 渠道 搜索)在「调用日志」页。
            </p>
            <div className="mb-8">
                <CallDetailTable rows={calls} />
            </div>

            {/* 5. Balance alert threshold (preserved from /balance) */}
            <BalanceAlertForm
                initialThreshold={
                    user.balance_alert_threshold_cny != null ? Number(user.balance_alert_threshold_cny) : 10
                }
            />

            {/* 6. Recharge history (preserved from /balance) */}
            <h2 className="m-0 mb-3 text-base font-semibold text-navy">充值流水</h2>
            {history.length === 0 ? (
                <Card>
                    <EmptyState
                        title="暂无充值记录"
                        body={
                            <>
                                点击右上「<code className="font-mono text-xs">+ 充值</code>」开始第一笔充值。
                            </>
                        }
                    />
                </Card>
            ) : (
                <Card className="overflow-hidden">
                    <table className="w-full border-collapse">
                        <thead>
                            <tr className="bg-paper-muted text-muted-ink">
                                <th className="border-b border-brand-border px-4 py-2.5 text-left text-xs font-semibold">
                                    金额(CNY)
                                </th>
                                <th className="border-b border-brand-border px-4 py-2.5 text-left text-xs font-semibold">
                                    类型
                                </th>
                                <th className="border-b border-brand-border px-4 py-2.5 text-left text-xs font-semibold">
                                    订单号
                                </th>
                                <th className="border-b border-brand-border px-4 py-2.5 text-left text-xs font-semibold">
                                    时间
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {history.map((row, idx) => {
                                const isLast = idx === history.length - 1;
                                const cell = `px-4 py-3 text-sm text-ink ${isLast ? '' : 'border-b border-brand-border'}`;
                                return (
                                    <tr key={row.id}>
                                        <td className={`${cell} font-medium tabular-nums`}>
                                            ¥{Number(row.amount).toFixed(2)}
                                        </td>
                                        <td className={cell}>{RECHARGE_SOURCE_LABEL[row.source] ?? row.source}</td>
                                        <td className={`${cell} font-mono text-xs text-muted-ink`}>
                                            {row.order_id ? row.order_id.slice(0, 8) : '—'}
                                        </td>
                                        <td className={`${cell} text-muted-ink`}>
                                            {row.created_at.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </Card>
            )}

            {/* 7. Reseller promo (preserved from old /dashboard) */}
            {resellerSnap.status !== 'active' && (
                <div className="mt-8">
                    <ResellerPromoCard sourceStatus={resellerSnap.status === null ? 'none' : resellerSnap.status} />
                </div>
            )}
        </section>
    );
}

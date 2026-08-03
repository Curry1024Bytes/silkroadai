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
import type { LucideIcon } from 'lucide-react';
import {
    Activity,
    ArrowUpRight,
    BarChart3,
    Coins,
    CreditCard,
    Database,
    History as HistoryIcon,
    ReceiptText,
    Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { getCustomerBalance, type CustomerBalance } from '@/lib/billing/customer-balance';
import { getUsageAggregate, unionSeedanceUsage, type UsageAggregateSnapshot } from '@/lib/newapi/usage-aggregate';
import { queryLogs, quotaToCny, type NewApiUsageLog } from '@/lib/newapi/client';
import { USD_TO_CNY_RATE } from '@/lib/newapi/quota-units';
import { Button } from '@/components/ui/Button';
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
import { isPerImageBilled, parseCacheTokens } from '@/lib/newapi/log-display';

export const dynamic = 'force-dynamic';
export const metadata = { title: '概览 — LLmRoute' };

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
    const cache = parseCacheTokens(log.other);
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
        // 缓存读写(参照 new-api 显示;Anthropic 面 prompt_tokens 不含缓存,单列才说得清费用)
        cacheReadTokens: cache.read,
        cacheWriteTokens: cache.write,
        // 按张计费(生图 ModelPrice)→ token 列显示 "—";按 token 计费(gpt-image-2 等)→ 显示真实 token。
        perImageBilled: isPerImageBilled(log.other, log.model_name),
        quota: log.quota,
        // Compute ¥ here (server) where NEWAPI_QUOTA_PER_USD/USD_TO_CNY_RATE are
        // available — CallDetailTable is a client island and must not convert.
        costCny: quotaToCny(log.quota),
        type: log.type,
        content: sanitizeLogContent(log.content),
    };
}

function MetricCell({
    icon: Icon,
    label,
    value,
    detail,
    className,
}: {
    icon: LucideIcon;
    label: string;
    value: ReactNode;
    detail: ReactNode;
    className?: string;
}) {
    return (
        <article className={['min-w-0 p-5 sm:p-6', className ?? ''].filter(Boolean).join(' ')}>
            <div className="mb-7 flex items-center justify-between gap-3">
                <p className="m-0 text-sm font-medium text-portal-muted">{label}</p>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-accent-soft text-brand-accent">
                    <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
                </span>
            </div>
            <p className="m-0 truncate font-display text-2xl font-semibold text-portal-ink tabular-nums sm:text-[28px]">
                {value}
            </p>
            <p className="m-0 mt-2 text-xs text-portal-subtle tabular-nums">{detail}</p>
        </article>
    );
}

const NO_DATA = <span className="text-base font-medium text-portal-subtle">暂无数据</span>;

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
            // seedance-cn 视频绕过 new-api、不进其日志,这里补进聚合让它在 dashboard 可见。
            agg = await unionSeedanceUsage(aggSettled.value, user.id, period);
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
    const displayName = user.nickname || user.email.split('@')[0];

    return (
        <section className="space-y-8">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                    <p className="m-0 mb-2 text-xs font-semibold text-brand-accent">账户概览</p>
                    <h1 className="m-0 font-display text-[28px] font-semibold leading-tight text-portal-ink">
                        你好，{displayName}
                    </h1>
                    <p className="m-0 mt-2 text-sm text-portal-muted">余额、用量和最近调用，一目了然。</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <PeriodTabs active={period} />
                    <Button href="/pay" size="md">
                        <CreditCard size={17} strokeWidth={1.8} aria-hidden="true" />
                        充值
                    </Button>
                </div>
            </div>

            {bal?.stale && (
                <div
                    role="status"
                    className="rounded-md border border-status-warning-border bg-status-warning-bg px-4 py-2.5 text-sm text-status-warning-text"
                >
                    余额数据暂时不可更新,显示的是稍早数据。
                </div>
            )}
            {balErr && (
                <div>
                    <FormError severity="banner">当前无法获取余额,请稍后重试。</FormError>
                </div>
            )}

            <div className="grid gap-4 lg:grid-cols-12">
                <article className="relative overflow-hidden rounded-lg border border-portal-line bg-portal-panel p-6 shadow-portal lg:col-span-4 lg:min-h-[220px]">
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <p className="m-0 text-sm font-medium text-portal-muted">当前余额</p>
                            <div className="mt-4">
                                {bal ? (
                                    <p className="m-0 font-display text-[38px] font-semibold leading-none text-portal-ink tabular-nums">
                                        ¥{bal.balanceCny.toFixed(2)}
                                    </p>
                                ) : (
                                    <p className="m-0 text-base font-medium text-portal-subtle">暂无数据</p>
                                )}
                            </div>
                            {bal && (
                                <p className="m-0 mt-3 text-xs text-portal-subtle tabular-nums">
                                    ≈ ${(bal.balanceCny / USD_TO_CNY_RATE).toFixed(2)} USD
                                    {bal.quota && <> · {bal.quota.remain.toLocaleString('en-US')} quota</>}
                                </p>
                            )}
                        </div>
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-accent-soft text-brand-accent">
                            <Wallet size={20} strokeWidth={1.7} aria-hidden="true" />
                        </span>
                    </div>

                    <div className="mt-8 flex items-end justify-between gap-4 border-t border-portal-line pt-4">
                        <div>
                            <p className="m-0 text-xs text-portal-subtle">历史消费</p>
                            <p className="m-0 mt-1 font-display text-lg font-semibold text-portal-ink tabular-nums">
                                {bal ? `¥${bal.spentCny.toFixed(2)}` : '暂无数据'}
                            </p>
                        </div>
                        <Link
                            href="/pay"
                            className="inline-flex items-center gap-1 text-xs font-semibold text-brand-accent no-underline transition-colors hover:text-brand-accent-strong"
                        >
                            账户充值 <ArrowUpRight size={14} aria-hidden="true" />
                        </Link>
                    </div>
                </article>

                <div className="grid overflow-hidden rounded-lg border border-portal-line bg-portal-panel shadow-portal sm:grid-cols-3 lg:col-span-8">
                    <MetricCell
                        icon={Coins}
                        label="本期消费"
                        value={agg ? `¥${quotaToCny(agg.totalUsedQuota).toFixed(2)}` : NO_DATA}
                        detail={
                            agg ? (
                                <>
                                    {periodLabel}
                                    {agg.source === 'fallback' && ' · 数据稍滞后'}
                                </>
                            ) : (
                                '当前周期'
                            )
                        }
                    />
                    <MetricCell
                        icon={Activity}
                        label="请求次数"
                        value={agg ? agg.totalCalls.toLocaleString('en-US') : NO_DATA}
                        detail={periodLabel}
                        className="border-t border-portal-line sm:border-l sm:border-t-0"
                    />
                    <MetricCell
                        icon={Database}
                        label="统计 Tokens"
                        value={agg ? totalTokens.toLocaleString('en-US') : NO_DATA}
                        detail={`${periodLabel} · 输入+输出`}
                        className="border-t border-portal-line sm:border-l sm:border-t-0"
                    />
                </div>
            </div>

            {usageErr && (
                <div>
                    <FormError severity="banner">
                        {usageErr === 'account_not_provisioned'
                            ? '账户尚未关联到上游,请联系管理员。'
                            : '当前无法获取用量数据,请稍后重试。'}
                    </FormError>
                </div>
            )}

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.9fr)_minmax(320px,0.8fr)]">
                <section className="min-w-0 rounded-lg border border-portal-line bg-portal-panel p-5 shadow-portal sm:p-6">
                    <div className="mb-5 flex items-start justify-between gap-4">
                        <div>
                            <div className="flex items-center gap-2">
                                <BarChart3
                                    size={18}
                                    className="text-portal-gold"
                                    strokeWidth={1.8}
                                    aria-hidden="true"
                                />
                                <h2 className="m-0 font-display text-base font-semibold text-portal-ink">
                                    模型消耗分布
                                </h2>
                            </div>
                            <p className="m-0 mt-1.5 text-xs text-portal-subtle">
                                按日展示各模型消费趋势 · {periodLabel}
                            </p>
                        </div>
                    </div>
                    <ModelConsumptionChart
                        byDay={agg?.byDay ?? []}
                        models={agg?.chartModels ?? []}
                        cnyPerQuota={quotaToCny(1)}
                    />
                </section>

                <aside className="rounded-lg border border-portal-line bg-portal-panel p-5 shadow-portal sm:p-6">
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <div>
                            <h2 className="m-0 font-display text-base font-semibold text-portal-ink">热门模型</h2>
                            <p className="m-0 mt-1 text-xs text-portal-subtle">按消费金额排序 · {periodLabel}</p>
                        </div>
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-portal-gold-soft text-portal-gold">
                            <Activity size={17} strokeWidth={1.8} aria-hidden="true" />
                        </span>
                    </div>

                    {byModel.length === 0 ? (
                        <div className="flex min-h-[248px] items-center justify-center border-t border-portal-line text-center text-sm text-portal-subtle">
                            暂无模型消费数据
                        </div>
                    ) : (
                        <ol className="m-0 list-none divide-y divide-portal-line p-0">
                            {byModel.map((model, index) => {
                                const pct = agg && agg.totalUsedQuota ? (model.quota / agg.totalUsedQuota) * 100 : 0;
                                return (
                                    <li key={model.model} className="py-4 first:pt-2 last:pb-0">
                                        <div className="flex items-start gap-3">
                                            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded bg-portal-soft text-[11px] font-semibold text-portal-muted">
                                                {index + 1}
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-start justify-between gap-3">
                                                    <p
                                                        className="m-0 truncate font-mono text-xs font-semibold text-portal-ink"
                                                        title={model.model}
                                                    >
                                                        {model.model}
                                                    </p>
                                                    <span className="shrink-0 text-xs font-semibold text-portal-ink tabular-nums">
                                                        ¥{quotaToCny(model.quota).toFixed(2)}
                                                    </span>
                                                </div>
                                                <div className="mt-2 flex items-center gap-3">
                                                    <div className="h-1 flex-1 overflow-hidden rounded-sm bg-portal-line">
                                                        <div
                                                            className="h-full bg-portal-gold"
                                                            style={{ width: `${Math.max(2, pct)}%` }}
                                                        />
                                                    </div>
                                                    <span className="w-10 text-right text-[11px] text-portal-subtle tabular-nums">
                                                        {pct.toFixed(1)}%
                                                    </span>
                                                </div>
                                                <p className="m-0 mt-1.5 text-[11px] text-portal-subtle tabular-nums">
                                                    {model.calls.toLocaleString('en-US')} 次调用
                                                </p>
                                            </div>
                                        </div>
                                    </li>
                                );
                            })}
                        </ol>
                    )}
                </aside>
            </div>

            <section aria-labelledby="recent-calls-title">
                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                        <div className="flex items-center gap-2">
                            <Activity size={18} className="text-portal-gold" strokeWidth={1.8} aria-hidden="true" />
                            <h2
                                id="recent-calls-title"
                                className="m-0 font-display text-base font-semibold text-portal-ink"
                            >
                                调用明细
                            </h2>
                        </div>
                        <p className="m-0 mt-1.5 text-xs text-portal-subtle">
                            最近调用的模型、密钥、耗时、Token、消费与结果 · {periodLabel}
                        </p>
                    </div>
                    <Link
                        href="/logs"
                        className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-portal-muted no-underline transition-colors hover:text-portal-ink"
                    >
                        查看全部日志 <ArrowUpRight size={14} aria-hidden="true" />
                    </Link>
                </div>
                <CallDetailTable rows={calls} />
            </section>

            <div className="grid items-start gap-4 xl:grid-cols-2">
                <BalanceAlertForm
                    initialThreshold={
                        user.balance_alert_threshold_cny != null ? Number(user.balance_alert_threshold_cny) : 10
                    }
                />

                <section className="overflow-hidden rounded-lg border border-portal-line bg-portal-panel shadow-portal">
                    <div className="flex items-start justify-between gap-4 border-b border-portal-line px-5 py-4 sm:px-6">
                        <div>
                            <div className="flex items-center gap-2">
                                <ReceiptText
                                    size={17}
                                    className="text-portal-gold"
                                    strokeWidth={1.8}
                                    aria-hidden="true"
                                />
                                <h2 className="m-0 font-display text-base font-semibold text-portal-ink">充值流水</h2>
                            </div>
                            <p className="m-0 mt-1 text-xs text-portal-subtle">最近 {HISTORY_LIMIT} 笔账户入账记录</p>
                        </div>
                        <HistoryIcon
                            size={17}
                            className="mt-0.5 text-portal-subtle"
                            strokeWidth={1.7}
                            aria-hidden="true"
                        />
                    </div>

                    {history.length === 0 ? (
                        <EmptyState
                            title="暂无充值记录"
                            body={
                                <>
                                    完成第一笔<code className="mx-1 font-mono text-xs">充值</code>后,记录会显示在这里。
                                </>
                            }
                            className="min-h-[210px] py-8"
                        />
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full border-collapse">
                                <thead>
                                    <tr className="bg-portal-soft text-portal-muted">
                                        <th className="border-b border-portal-line px-5 py-2.5 text-left text-xs font-semibold">
                                            金额(CNY)
                                        </th>
                                        <th className="border-b border-portal-line px-5 py-2.5 text-left text-xs font-semibold">
                                            类型
                                        </th>
                                        <th className="border-b border-portal-line px-5 py-2.5 text-left text-xs font-semibold">
                                            订单号
                                        </th>
                                        <th className="border-b border-portal-line px-5 py-2.5 text-left text-xs font-semibold">
                                            时间
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {history.map((row, idx) => {
                                        const isLast = idx === history.length - 1;
                                        const cell = `whitespace-nowrap px-5 py-3 text-sm text-portal-ink ${isLast ? '' : 'border-b border-portal-line'}`;
                                        return (
                                            <tr key={row.id} className="transition-colors hover:bg-portal-soft">
                                                <td className={`${cell} font-semibold tabular-nums`}>
                                                    ¥{Number(row.amount).toFixed(2)}
                                                </td>
                                                <td className={cell}>
                                                    {RECHARGE_SOURCE_LABEL[row.source] ?? row.source}
                                                </td>
                                                <td className={`${cell} font-mono text-xs text-portal-muted`}>
                                                    {row.order_id ? row.order_id.slice(0, 8) : '—'}
                                                </td>
                                                <td className={`${cell} text-portal-muted`}>
                                                    {row.created_at.toLocaleString('zh-CN', {
                                                        timeZone: 'Asia/Shanghai',
                                                    })}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>
            </div>

            {resellerSnap.status !== 'active' && (
                <ResellerPromoCard sourceStatus={resellerSnap.status === null ? 'none' : resellerSnap.status} />
            )}
        </section>
    );
}

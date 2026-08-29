/**
 * /dashboard streaming sections(P1 — 2026-08-29)。
 *
 * page.tsx 拆成「快壳」+「慢区块」两层:壳(标题/tabs/余额提醒表单/充值
 * 流水/reseller 卡,全是本地 DB)立即渲染;这里的区块依赖慢请求 ——
 * getCustomerBalance 在 newapi 模式 quota cache miss 时要打 new-api,用量
 * 聚合 + 3 个 call-log 切片是跨机 new-api HTTP 调用。每个区块是 async
 * server component,await 的是 page.tsx 里【只发起一次、多处共享】的
 * promise(loadBalanceData / loadUsageData),外面套 <Suspense>,壳 +
 * 骨架先画,数据到了流式补进来。
 *
 * 两个 loader 永不 reject —— resolve 成带 error 标记的形状,共享 promise
 * 才不会一处失败炸掉所有 boundary(分区降级语义与拆分前一致)。
 */
import type { ReactNode } from 'react';
import { getCustomerBalance, type CustomerBalance } from '@/lib/billing/customer-balance';
import { getUsageAggregate, unionSeedanceUsage, type UsageAggregateSnapshot } from '@/lib/newapi/usage-aggregate';
import { quotaToCny, type NewApiUsageLog } from '@/lib/newapi/client';
import { queryLogsCached } from '@/lib/newapi/logs-cache';
import { USD_TO_CNY_RATE } from '@/lib/newapi/quota-units';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { FormError } from '@/components/ui/FormError';
import { ModelConsumptionChart } from './model-consumption-chart';
import { CallDetailTable, type CallRow } from './call-detail-table';
import { matchFailedVideoConsumes } from './failed-video-match';
import { collapseRetriedFailures, sanitizeLogContent } from './format';
import { isPerImageBilled, parseCacheTokens } from '@/lib/newapi/log-display';
import { periodToRange, type UsagePeriod } from './period';

/** Recent-call fetch sizes for the detail table. The full-period TOTALS come
 *  from the aggregator (up to 50k rows); these two slices are only for the
 *  "每次调用明细" rows, so a bounded recent window keeps the render fast.
 *  Errors (type=5) are rarer, so a smaller slice. The merged list is capped
 *  at CALLS_CAP — paginated client-side in CallDetailTable. */
const CONSUME_FETCH_SIZE = 150;
const ERROR_FETCH_SIZE = 50;
const TASKFAIL_FETCH_SIZE = 50; // type=6 视频任务失败(退款)记录,用于把对应 type=2 行标成失败·已退款
const CALLS_CAP = 200;
const TOP_MODELS = 5;

const BIG = 'm-0 text-2xl font-semibold text-navy tabular-nums';
const SUB = 'mt-1.5 m-0 text-xs text-minor-ink tabular-nums';
const NO_DATA = <p className="m-0 text-sm text-minor-ink">暂无数据</p>;

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

// ────────────────────────── data loaders(共享 promise)──────────────────────────

export interface BalanceData {
    bal: CustomerBalance | null;
    balErr: boolean;
}

/** Balance (P4c-3.5 fork — never read quota directly). Never rejects. */
export async function loadBalanceData(userId: string): Promise<BalanceData> {
    try {
        return { bal: await getCustomerBalance(userId), balErr: false };
    } catch (err) {
        console.warn(`[dashboard] getCustomerBalance failed for user ${userId}:`, err);
        return { bal: null, balErr: true };
    }
}

export interface UsageData {
    agg: UsageAggregateSnapshot | null;
    usageErr: 'account_not_provisioned' | 'fetch_failed' | null;
    calls: CallRow[];
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

/** Usage aggregate + per-call logs (period-scoped). Never rejects. */
export async function loadUsageData(args: {
    portalUserId: string;
    newapiUserId: number | null;
    newapiUsername: string | null;
    period: UsagePeriod;
}): Promise<UsageData> {
    const { portalUserId, newapiUserId, newapiUsername, period } = args;
    if (newapiUserId == null || newapiUsername == null) {
        return { agg: null, usageErr: 'account_not_provisioned', calls: [] };
    }

    // username is the dimension new-api honors under admin auth (gotcha
    // #15 — user_id is silently dropped); we still post-filter every row
    // by user_id for defence-in-depth. type=2 (成功) + type=5 (失败) are
    // fetched separately, then merged + sorted desc for the detail table.
    const range = periodToRange(period);
    const logWindow = {
        start_timestamp: range.start || undefined,
        end_timestamp: range.end,
        page: 1,
    };
    const [aggSettled, consumeSettled, errorSettled, taskFailSettled] = await Promise.allSettled([
        getUsageAggregate({ portalUserId, newapiUserId, newapiUsername, period }),
        queryLogsCached({ username: newapiUsername, type: 2, ...logWindow, page_size: CONSUME_FETCH_SIZE }),
        queryLogsCached({ username: newapiUsername, type: 5, ...logWindow, page_size: ERROR_FETCH_SIZE }),
        // type=6 视频异步任务失败 → 退还预扣 quota;用来把对应 type=2 消费标成失败·已退款
        queryLogsCached({ username: newapiUsername, type: 6, ...logWindow, page_size: TASKFAIL_FETCH_SIZE }),
    ]);

    let agg: UsageAggregateSnapshot | null = null;
    let usageErr: UsageData['usageErr'] = null;
    if (aggSettled.status === 'fulfilled') {
        // seedance-cn 视频绕过 new-api、不进其日志,这里补进聚合让它在 dashboard 可见。
        agg = await unionSeedanceUsage(aggSettled.value, portalUserId, period);
    } else {
        usageErr = 'fetch_failed';
        console.warn(`[dashboard] getUsageAggregate failed for user ${portalUserId}:`, aggSettled.reason);
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
        console.warn(`[dashboard] consume queryLogs failed for user ${portalUserId}:`, consumeSettled.reason);
    }
    if (errorSettled.status === 'rejected') {
        console.warn(`[dashboard] error queryLogs failed for user ${portalUserId}:`, errorSettled.reason);
    }
    // 视频异步任务失败(type=6)会退还预扣费用(净扣 0)。把对应的 type=2 消费标成失败·已退款,
    // 否则明细表会把失败任务错显示成「成功 ¥X」(客户以为没出片还被扣钱)。
    const failedConsumeIds = matchFailedVideoConsumes(consume, taskFailed);
    // 折叠"失败了但重试 / failover 成功"的中间失败行(见 collapseRetriedFailures)——
    // 否则客户日志被 429/上游饱和这类中间过程刷屏,主观以为出了大问题。真失败(内容拒绝等)照常显示。
    const visibleErrors = collapseRetriedFailures(consume, errors);
    const calls = [...consume, ...visibleErrors]
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

    return { agg, usageErr, calls };
}

// ────────────────────────── streamed sections ──────────────────────────

/** 余额 stale / 失败横幅(在汇总卡上方)。无事可报时渲染 null。 */
export async function BalanceNotices({ data }: { data: Promise<BalanceData> }) {
    const { bal, balErr } = await data;
    if (!bal?.stale && !balErr) return null;
    return (
        <>
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
        </>
    );
}

/** 汇总卡 1-2:当前余额 / 历史消费(依赖 balance)。 */
export async function BalanceStatCards({ data }: { data: Promise<BalanceData> }) {
    const { bal } = await data;
    return (
        <>
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
        </>
    );
}

/** 汇总卡 3-5:请求次数 / 统计 Tokens / 本期消费(依赖用量聚合)。 */
export async function UsageStatCards({ data, periodLabel }: { data: Promise<UsageData>; periodLabel: string }) {
    const { agg } = await data;
    const totalTokens = agg ? agg.totalTokens : 0;
    return (
        <>
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
        </>
    );
}

/** 用量主体:错误横幅 + 模型消耗分布图 + 按模型 Top N + 调用明细表。 */
export async function UsageBody({ data, periodLabel }: { data: Promise<UsageData>; periodLabel: string }) {
    const { agg, usageErr, calls } = await data;
    const byModel = agg ? agg.byModel.slice(0, TOP_MODELS) : [];
    return (
        <>
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
        </>
    );
}

// ────────────────────────── skeleton fallbacks ──────────────────────────

function Bone({ className }: { className: string }) {
    return <div aria-hidden className={`animate-pulse rounded-md bg-paper-muted ${className}`} />;
}

/** N 张汇总卡的骨架(与 StatCard 同壳,避免流入时布局跳动)。 */
export function StatCardSkeletons({ count }: { count: number }) {
    return (
        <>
            {Array.from({ length: count }, (_, i) => (
                <Card as="article" key={i}>
                    <CardHeader>
                        <Bone className="h-4 w-16" />
                    </CardHeader>
                    <CardContent>
                        <Bone className="mb-2 h-7 w-24" />
                        <Bone className="h-3 w-24" />
                    </CardContent>
                </Card>
            ))}
        </>
    );
}

/** 用量主体骨架:真实标题(不闪)+ 图表块 + 明细行。 */
export function UsageBodySkeleton({ periodLabel }: { periodLabel: string }) {
    return (
        <>
            <h2 className="m-0 mb-3 text-base font-semibold text-navy">模型消耗分布 · {periodLabel}</h2>
            <div className="mb-6">
                <Bone className="h-64 w-full" />
            </div>
            <div className="mb-3 flex items-end justify-between gap-3">
                <h2 className="m-0 text-base font-semibold text-navy">调用明细 · {periodLabel}</h2>
            </div>
            <div className="mb-8 space-y-3">
                {Array.from({ length: 6 }, (_, i) => (
                    <Bone key={i} className="h-9 w-full" />
                ))}
            </div>
        </>
    );
}

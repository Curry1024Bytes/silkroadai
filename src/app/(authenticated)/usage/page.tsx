/**
 * /usage — call history + per-model breakdown for the logged-in customer.
 *
 * Server component:
 *   1. getCurrentUser (cache()-deduped with layout's call — single DB read)
 *   2. queryLogs against new-api with `user_id` filter (NOT `username` — see
 *      W3 D2 F2: username filter has been observed returning 0 against
 *      matching logs)
 *   3. Aggregate via getUsageAggregate (5-min cache, paginated full window)
 *   4. Render summary + by-model bars + recent-50 table
 *
 * Time window driven by `?period=7d|30d|all` querystring. Tabs are a small
 * client component — Link href changes navigate to a new render with the
 * fresh window.
 */
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/session';
import { queryLogs, quotaToCny, type NewApiUsageLog } from '@/lib/newapi/client';
import { getUsageAggregate } from '@/lib/newapi/usage-aggregate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormError } from '@/components/ui/FormError';
import { PeriodTabs } from './period-tabs';
import { parsePeriod, periodToRange, type UsagePeriod } from './period';

export const dynamic = 'force-dynamic';
export const metadata = { title: '用量 — Silk Road AI' };

const RECENT_LIMIT = 50;
const TOP_MODELS = 5;
/**
 * W6 D5: how many recent rows we still pull through queryLogs for the
 * "最近调用" table. The aggregate (totals + by-model top-5) now comes
 * from the cached aggregator, so this fetch is purely for the table —
 * 50 rows is plenty for the last-N-calls UI and doesn't depend on the
 * aggregator being fresh.
 */
const RECENT_FETCH_PAGE_SIZE = 50;

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/usage', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

export default async function UsagePage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const user = await getSessionUser();
    if (!user) return null;

    const params = (await searchParams) ?? {};
    const period: UsagePeriod = parsePeriod(params.period);
    const range = periodToRange(period);

    let aggSnap: Awaited<ReturnType<typeof getUsageAggregate>> | null = null;
    let recentLogs: NewApiUsageLog[] = [];
    let queryErr: string | null = null;
    const newapiUserId = user.newapi_user_id;
    const newapiUsername = user.newapi_username;
    if (newapiUserId == null || newapiUsername == null) {
        queryErr = 'account_not_provisioned';
    } else {
        // Two parallel fetches: the aggregator (cached, totals + top-5) and
        // a small `queryLogs` slice for the recent-50 table. The two are
        // independent — if the aggregator falls back to stale data, we
        // can still show fresh recent rows; if the recent-50 fetch fails
        // we still have totals.
        //
        // W7 D4 PR-J Bug 2: queryLogs filters on `username` (admin auth
        // silently drops `user_id`, gotcha #15). Defensive post-filter
        // below scrubs any cross-user rows new-api might still leak.
        const [aggSettled, recentSettled] = await Promise.allSettled([
            getUsageAggregate({
                portalUserId: user.id,
                newapiUserId,
                newapiUsername,
                period,
            }),
            queryLogs({
                username: newapiUsername,
                type: 2,
                start_timestamp: range.start || undefined,
                end_timestamp: range.end,
                page: 1,
                page_size: RECENT_FETCH_PAGE_SIZE,
            }),
        ]);

        if (aggSettled.status === 'fulfilled') {
            aggSnap = aggSettled.value;
        } else {
            queryErr = aggSettled.reason instanceof Error ? aggSettled.reason.message : String(aggSettled.reason);
            console.warn(`[usage] getUsageAggregate failed for user ${user.id}:`, aggSettled.reason);
        }

        if (recentSettled.status === 'fulfilled') {
            // Belt-and-suspenders: scrub cross-user rows from the recent-50
            // table the same way fetchLiveAggregate does. If new-api ever
            // regresses on the username filter we won't accidentally render
            // someone else's username / model_name in the table.
            recentLogs = recentSettled.value.items.filter((log) => log.user_id === newapiUserId);
        } else {
            // Recent-50 failure is non-fatal — fall through with empty list.
            console.warn(`[usage] recent queryLogs failed for user ${user.id}:`, recentSettled.reason);
        }
    }

    const agg = aggSnap
        ? {
              totalCalls: aggSnap.totalCalls,
              totalQuota: aggSnap.totalUsedQuota,
              byModel: aggSnap.byModel.slice(0, TOP_MODELS),
          }
        : { totalCalls: 0, totalQuota: 0, byModel: [] as Array<{ model: string; calls: number; quota: number }> };

    const recent = recentLogs
        .filter((l) => l.type === 2)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, RECENT_LIMIT);

    return (
        <section>
            <div className="flex justify-between items-start gap-3 flex-wrap mb-5">
                <div>
                    <h1 className="m-0 mb-2 text-2xl font-semibold text-navy">用量</h1>
                    <p className="m-0 text-sm text-muted-ink">按模型与时间维度的调用统计。</p>
                </div>
                <PeriodTabs active={period} />
            </div>

            {queryErr && (
                <div className="mb-6">
                    <FormError severity="banner">
                        {queryErr === 'account_not_provisioned'
                            ? '账户尚未关联到上游,请联系管理员。'
                            : '当前无法获取用量数据,请稍后重试。'}
                    </FormError>
                </div>
            )}

            {!queryErr && agg.totalCalls === 0 ? (
                <Card>
                    <EmptyState
                        title="该时间段内无 API 调用记录"
                        body={
                            <>
                                前往{' '}
                                <Link href="/keys" className="text-navy font-medium">
                                    API Keys
                                </Link>{' '}
                                页创建 key 后开始调用。
                            </>
                        }
                    />
                </Card>
            ) : !queryErr ? (
                <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                        <Card as="article">
                            <CardHeader>
                                <CardTitle as="h3" className="text-sm font-medium text-muted-ink">
                                    总调用次数
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="m-0 text-3xl font-semibold text-navy tabular-nums">
                                    {agg.totalCalls.toLocaleString('en-US')}
                                </p>
                            </CardContent>
                        </Card>
                        <Card as="article">
                            <CardHeader>
                                <CardTitle as="h3" className="text-sm font-medium text-muted-ink">
                                    总消费(CNY 等价)
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="m-0 text-3xl font-semibold text-navy tabular-nums">
                                    ¥{quotaToCny(agg.totalQuota).toFixed(2)}
                                </p>
                                <p className="mt-1.5 m-0 text-xs text-minor-ink tabular-nums">
                                    {agg.totalQuota.toLocaleString('en-US')} quota
                                </p>
                            </CardContent>
                        </Card>
                    </div>

                    {agg.byModel.length > 0 && (
                        <>
                            <h2 className="m-0 mb-3 text-base font-semibold text-navy">
                                按模型 Top {agg.byModel.length}
                            </h2>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
                                {agg.byModel.map((m) => {
                                    const pct = agg.totalQuota ? (m.quota / agg.totalQuota) * 100 : 0;
                                    return (
                                        <Card as="article" key={m.model} className="px-4 py-3">
                                            <p
                                                className="m-0 mb-1 text-sm font-semibold text-navy overflow-hidden text-ellipsis whitespace-nowrap font-mono"
                                                title={m.model}
                                            >
                                                {m.model}
                                            </p>
                                            <p className="m-0 mb-2 text-xs text-muted-ink tabular-nums">
                                                {m.calls.toLocaleString('en-US')} 次 · {pct.toFixed(1)}%
                                            </p>
                                            <div className="bg-paper-muted rounded-sm overflow-hidden h-1.5">
                                                <div
                                                    className="bg-brand-accent h-full"
                                                    style={{ width: `${Math.max(2, pct)}%` }}
                                                />
                                            </div>
                                        </Card>
                                    );
                                })}
                            </div>
                        </>
                    )}

                    <h2 className="m-0 mb-3 text-base font-semibold text-navy">
                        最近调用(前 {Math.min(recent.length, RECENT_LIMIT)} 条)
                    </h2>
                    <Card className="overflow-hidden">
                        <table className="w-full border-collapse">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        模型
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        时间
                                    </th>
                                    <th className="text-right px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        quota
                                    </th>
                                    <th className="text-right px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        completion tokens
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {recent.map((log, idx) => {
                                    const isLast = idx === recent.length - 1;
                                    const cell = `px-4 py-3 text-sm text-ink ${isLast ? '' : 'border-b border-brand-border'}`;
                                    return (
                                        <tr key={log.id}>
                                            <td className={`${cell} font-mono text-xs`}>
                                                {log.model_name || '<unknown>'}
                                            </td>
                                            <td className={`${cell} text-muted-ink`}>
                                                {new Date(log.created_at * 1000).toLocaleString('zh-CN')}
                                            </td>
                                            <td className={`${cell} text-right tabular-nums`}>
                                                {log.quota.toLocaleString('en-US')}
                                            </td>
                                            <td className={`${cell} text-right tabular-nums text-muted-ink`}>
                                                {log.completion_tokens.toLocaleString('en-US')}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </Card>

                    <div className="flex justify-end mt-3">
                        <button
                            type="button"
                            disabled
                            title="W6 实装"
                            className={[
                                'bg-paper-muted text-minor-ink border border-brand-border',
                                'rounded-lg px-4 py-1.5 text-xs cursor-not-allowed',
                            ].join(' ')}
                        >
                            查看更多(W6)
                        </button>
                    </div>
                </>
            ) : null}
        </section>
    );
}

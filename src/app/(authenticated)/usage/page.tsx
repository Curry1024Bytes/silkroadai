/**
 * /usage — call history + per-model breakdown for the logged-in customer.
 *
 * Server component:
 *   1. getCurrentUser (cache()-deduped with layout's call — single DB read)
 *   2. queryLogs against new-api with `user_id` filter (NOT `username` — see
 *      W3 D2 F2: username filter has been observed returning 0 against
 *      matching logs)
 *   3. Aggregate server-side: total calls, total quota, top-5 by model
 *   4. Render summary + by-model bars + recent-50 table
 *
 * Time window driven by `?period=7d|30d|all` querystring. Tabs are a small
 * client component — Link href changes navigate to a new render with the
 * fresh window.
 *
 * No new endpoint: the page is the only consumer; client-side dynamic
 * filtering can be added in W6 if customer demand surfaces.
 */
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/session';
import {
    queryLogs,
    quotaToCny,
    type NewApiUsageLog,
} from '@/lib/newapi/client';
import { getUsageAggregate } from '@/lib/newapi/usage-aggregate';
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

// W6 D5 sweep: the previous client-side aggregate(logs) helper has been
// replaced by `getUsageAggregate` in `src/lib/newapi/usage-aggregate.ts`.
// That helper paginates the full window (up to 50 pages × 1000 rows) and
// caches the rolled-up payload for 5 minutes — closing the W3 D2 F3
// long-tail gap where users with > 200 logs/window saw under-counted
// totals from the page_size=200 single-fetch.

const cardStyle: React.CSSProperties = {
    background: '#fff',
    border: '1px solid #e5e8ee',
    borderRadius: 6,
    padding: 20,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
};
const tableHeaderStyle: React.CSSProperties = {
    textAlign: 'left',
    padding: '8px 12px',
    fontSize: 12,
    color: '#5a6478',
    background: '#f5f7fa',
    borderBottom: '1px solid #e5e8ee',
};
const tableCellStyle: React.CSSProperties = {
    padding: '10px 12px',
    fontSize: 13,
    borderBottom: '1px solid #e5e8ee',
    color: '#1a2540',
};

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
    if (user.newapi_user_id == null) {
        queryErr = 'account_not_provisioned';
    } else {
        // Two parallel fetches: the aggregator (cached, totals + top-5) and
        // a small `queryLogs` slice for the recent-50 table. The two are
        // independent — if the aggregator falls back to stale data, we
        // can still show fresh recent rows; if the recent-50 fetch fails
        // we still have totals.
        const [aggSettled, recentSettled] = await Promise.allSettled([
            getUsageAggregate({
                portalUserId: user.id,
                newapiUserId: user.newapi_user_id,
                period,
            }),
            queryLogs({
                user_id: user.newapi_user_id,
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
            queryErr =
                aggSettled.reason instanceof Error
                    ? aggSettled.reason.message
                    : String(aggSettled.reason);
            console.warn(`[usage] getUsageAggregate failed for user ${user.id}:`, aggSettled.reason);
        }

        if (recentSettled.status === 'fulfilled') {
            recentLogs = recentSettled.value.items;
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
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    marginBottom: 20,
                    gap: 12,
                    flexWrap: 'wrap',
                }}
            >
                <div>
                    <h1 style={{ margin: '0 0 8px', fontSize: 22, color: '#0a1535' }}>用量</h1>
                    <p style={{ margin: 0, fontSize: 13, color: '#5a6478' }}>
                        按模型与时间维度的调用统计。
                    </p>
                </div>
                <PeriodTabs active={period} />
            </div>

            {queryErr && (
                <div
                    role="alert"
                    style={{
                        background: '#fdecea',
                        border: '1px solid #f0c6c2',
                        color: '#c44',
                        padding: '12px 14px',
                        borderRadius: 6,
                        marginBottom: 24,
                        fontSize: 13,
                    }}
                >
                    {queryErr === 'account_not_provisioned'
                        ? '账户尚未关联到上游,请联系管理员。'
                        : '当前无法获取用量数据,请稍后重试。'}
                </div>
            )}

            {!queryErr && agg.totalCalls === 0 ? (
                <div
                    style={{
                        background: '#fff',
                        border: '1px dashed #e5e8ee',
                        borderRadius: 6,
                        padding: 32,
                        textAlign: 'center',
                        color: '#8a92a4',
                        fontSize: 13,
                    }}
                >
                    该时间段内无 API 调用记录,前往{' '}
                    <Link href="/keys" style={{ color: '#0a1535' }}>
                        API Keys
                    </Link>{' '}
                    页创建 key 后开始调用。
                </div>
            ) : !queryErr ? (
                <>
                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                            gap: 16,
                            marginBottom: 24,
                        }}
                    >
                        <article style={cardStyle}>
                            <p style={{ margin: '0 0 6px', fontSize: 12, color: '#5a6478' }}>
                                总调用次数
                            </p>
                            <p
                                style={{
                                    margin: 0,
                                    fontSize: 28,
                                    color: '#0a1535',
                                    fontWeight: 600,
                                    fontVariantNumeric: 'tabular-nums',
                                }}
                            >
                                {agg.totalCalls.toLocaleString('en-US')}
                            </p>
                        </article>
                        <article style={cardStyle}>
                            <p style={{ margin: '0 0 6px', fontSize: 12, color: '#5a6478' }}>
                                总消费(CNY 等价)
                            </p>
                            <p
                                style={{
                                    margin: 0,
                                    fontSize: 28,
                                    color: '#0a1535',
                                    fontWeight: 600,
                                    fontVariantNumeric: 'tabular-nums',
                                }}
                            >
                                ¥{quotaToCny(agg.totalQuota).toFixed(2)}
                            </p>
                            <p style={{ margin: '6px 0 0', fontSize: 11, color: '#8a92a4' }}>
                                {agg.totalQuota.toLocaleString('en-US')} quota
                            </p>
                        </article>
                    </div>

                    {agg.byModel.length > 0 && (
                        <>
                            <h2
                                style={{
                                    margin: '0 0 12px',
                                    fontSize: 16,
                                    color: '#0a1535',
                                }}
                            >
                                按模型 Top {agg.byModel.length}
                            </h2>
                            <div
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns:
                                        'repeat(auto-fit, minmax(180px, 1fr))',
                                    gap: 12,
                                    marginBottom: 24,
                                }}
                            >
                                {agg.byModel.map((m) => {
                                    const pct = agg.totalQuota
                                        ? (m.quota / agg.totalQuota) * 100
                                        : 0;
                                    return (
                                        <article
                                            key={m.model}
                                            style={{ ...cardStyle, padding: 14 }}
                                        >
                                            <p
                                                style={{
                                                    margin: '0 0 4px',
                                                    fontSize: 13,
                                                    color: '#0a1535',
                                                    fontWeight: 600,
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap',
                                                }}
                                                title={m.model}
                                            >
                                                {m.model}
                                            </p>
                                            <p
                                                style={{
                                                    margin: '0 0 8px',
                                                    fontSize: 11,
                                                    color: '#5a6478',
                                                    fontVariantNumeric: 'tabular-nums',
                                                }}
                                            >
                                                {m.calls.toLocaleString('en-US')} 次 ·{' '}
                                                {pct.toFixed(1)}%
                                            </p>
                                            <div
                                                style={{
                                                    background: '#f0f2f8',
                                                    borderRadius: 2,
                                                    overflow: 'hidden',
                                                    height: 6,
                                                }}
                                            >
                                                <div
                                                    style={{
                                                        background: '#0a1535',
                                                        height: '100%',
                                                        width: `${Math.max(2, pct)}%`,
                                                    }}
                                                />
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        </>
                    )}

                    <h2
                        style={{
                            margin: '0 0 12px',
                            fontSize: 16,
                            color: '#0a1535',
                        }}
                    >
                        最近调用(前 {Math.min(recent.length, RECENT_LIMIT)} 条)
                    </h2>
                    <table
                        style={{
                            width: '100%',
                            background: '#fff',
                            border: '1px solid #e5e8ee',
                            borderRadius: 6,
                            borderCollapse: 'collapse',
                            overflow: 'hidden',
                        }}
                    >
                        <thead>
                            <tr>
                                <th style={tableHeaderStyle}>模型</th>
                                <th style={tableHeaderStyle}>时间</th>
                                <th
                                    style={{
                                        ...tableHeaderStyle,
                                        textAlign: 'right',
                                    }}
                                >
                                    quota
                                </th>
                                <th
                                    style={{
                                        ...tableHeaderStyle,
                                        textAlign: 'right',
                                    }}
                                >
                                    completion tokens
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {recent.map((log) => (
                                <tr key={log.id}>
                                    <td
                                        style={{
                                            ...tableCellStyle,
                                            fontFamily:
                                                'ui-monospace, SFMono-Regular, Menlo, monospace',
                                            fontSize: 12,
                                        }}
                                    >
                                        {log.model_name || '<unknown>'}
                                    </td>
                                    <td style={{ ...tableCellStyle, color: '#5a6478' }}>
                                        {new Date(log.created_at * 1000).toLocaleString('zh-CN')}
                                    </td>
                                    <td
                                        style={{
                                            ...tableCellStyle,
                                            textAlign: 'right',
                                            fontVariantNumeric: 'tabular-nums',
                                        }}
                                    >
                                        {log.quota.toLocaleString('en-US')}
                                    </td>
                                    <td
                                        style={{
                                            ...tableCellStyle,
                                            textAlign: 'right',
                                            fontVariantNumeric: 'tabular-nums',
                                            color: '#5a6478',
                                        }}
                                    >
                                        {log.completion_tokens.toLocaleString('en-US')}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    <div
                        style={{
                            display: 'flex',
                            justifyContent: 'flex-end',
                            marginTop: 12,
                        }}
                    >
                        <button
                            type="button"
                            disabled
                            title="W6 实装"
                            style={{
                                background: '#f5f7fa',
                                color: '#a8aebc',
                                border: '1px solid #e5e8ee',
                                borderRadius: 4,
                                padding: '6px 14px',
                                fontSize: 12,
                                cursor: 'not-allowed',
                            }}
                        >
                            查看更多(W6)
                        </button>
                    </div>
                </>
            ) : null}
        </section>
    );
}

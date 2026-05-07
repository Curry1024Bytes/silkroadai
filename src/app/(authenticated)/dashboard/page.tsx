/**
 * /dashboard — landing page for authenticated users.
 *
 * W6 D5 replaces the W4-2 D4 placeholder cards with real data:
 *   - Card 1: 当前余额 (getQuotaWithCache, W4-2 D6 helper)
 *   - Card 2: 上月消费 (UsageAggregate period='last_month', W6 D5)
 *   - Card 3: 累计调用次数 (UsageAggregate period='all', W6 D5)
 *   - Card 4: 最常用模型 Top 3 (UsageAggregate period='30d' byModel slice 3)
 *
 * Plus a row of quick-link buttons to /pay, /keys, /usage, /models.
 *
 * All four data fetches run in parallel via `Promise.allSettled` — if one
 * fails (e.g. new-api blip on the all-time aggregate), the others still
 * render. Per-card error states are inline (re-cast as <EmptyState> in W7
 * P2 so they read as intentional empties rather than UI bugs).
 */
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/session';
import { getQuotaWithCache } from '@/lib/newapi/quota-cache';
import { getUsageAggregate } from '@/lib/newapi/usage-aggregate';
import { quotaToCny, quotaToUsd } from '@/lib/newapi/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';

export const dynamic = 'force-dynamic';
export const metadata = { title: '概览 — Silk Road AI' };

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/dashboard', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

interface QuickLink {
    href: string;
    label: string;
    desc: string;
}
const QUICK_LINKS: QuickLink[] = [
    { href: '/pay', label: '充值', desc: '为账户余额充值' },
    { href: '/keys', label: '管理 Keys', desc: '创建 / 撤销 / 查用量' },
    { href: '/usage', label: '查看用量', desc: '按模型、按时间统计' },
    { href: '/models', label: '模型清单', desc: '当前接入的全部模型' },
];

export default async function DashboardPage() {
    const user = await getSessionUser();
    // Layout has already gated; this branch should never run, but typescript
    // narrows `user` to non-null only after the explicit check.
    if (!user) {
        return null;
    }

    const newapiUserId = user.newapi_user_id;
    const newapiUsername = user.newapi_username;
    // W7 D4 PR-J Bug 2: aggregator now needs both — username for the
    // upstream filter (the dimension new-api actually honors under admin
    // auth, gotcha #15) and user_id for a defensive cross-row post-filter.
    // Provision sets both atomically (W2 D6 provisionNewCustomer), so the
    // null guard is just type narrowing for TS, not a real edge case.
    const aggArgsBase: { portalUserId: string; newapiUserId: number; newapiUsername: string } | null =
        newapiUserId != null && newapiUsername != null
            ? { portalUserId: user.id, newapiUserId, newapiUsername }
            : null;

    // Four parallel fetches via allSettled — a single new-api blip on one
    // card doesn't take out the whole page. Per-card error states render
    // inline below.
    const [balanceSettled, lastMonthSettled, allTimeSettled, top3Settled] = await Promise.allSettled([
        getQuotaWithCache(user.id),
        aggArgsBase
            ? getUsageAggregate({ ...aggArgsBase, period: 'last_month' })
            : Promise.reject(new Error('account_not_provisioned')),
        aggArgsBase
            ? getUsageAggregate({ ...aggArgsBase, period: 'all' })
            : Promise.reject(new Error('account_not_provisioned')),
        aggArgsBase
            ? getUsageAggregate({ ...aggArgsBase, period: '30d' })
            : Promise.reject(new Error('account_not_provisioned')),
    ]);

    const balance = balanceSettled.status === 'fulfilled' ? balanceSettled.value : null;
    const lastMonth = lastMonthSettled.status === 'fulfilled' ? lastMonthSettled.value : null;
    const allTime = allTimeSettled.status === 'fulfilled' ? allTimeSettled.value : null;
    const top3 = top3Settled.status === 'fulfilled' ? top3Settled.value : null;

    // Log per-card failures once (server stderr is enough — not Sentry-worthy
    // for individual user dashboard renders; the underlying helper already
    // captures the new-api outage to Sentry on hard-fail).
    if (balanceSettled.status === 'rejected') {
        console.warn(`[dashboard] balance fetch failed for user ${user.id}:`, balanceSettled.reason);
    }
    if (lastMonthSettled.status === 'rejected') {
        console.warn(`[dashboard] last_month fetch failed for user ${user.id}:`, lastMonthSettled.reason);
    }
    if (allTimeSettled.status === 'rejected') {
        console.warn(`[dashboard] all_time fetch failed for user ${user.id}:`, allTimeSettled.reason);
    }
    if (top3Settled.status === 'rejected') {
        console.warn(`[dashboard] top3 fetch failed for user ${user.id}:`, top3Settled.reason);
    }

    return (
        <section>
            <h1 className="m-0 mb-2 text-2xl font-semibold text-navy">
                欢迎,{user.nickname || user.email.split('@')[0]}
            </h1>
            <p className="m-0 mb-6 text-sm text-muted-ink">
                这是您的客户后台。在这里管理 API Keys、查看余额与用量。
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                {/* Card 1: Current balance */}
                <Card as="article">
                    <CardHeader>
                        <CardTitle as="h3" className="text-sm font-medium text-muted-ink">
                            当前余额
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {balance ? (
                            <>
                                <p className="m-0 text-3xl font-semibold text-navy tabular-nums">
                                    ¥{quotaToCny(balance.remain_quota).toFixed(2)}
                                </p>
                                <p className="mt-1.5 m-0 text-xs text-minor-ink tabular-nums">
                                    ≈ ${quotaToUsd(balance.remain_quota).toFixed(4)} USD
                                    {balance.source === 'fallback' && ' · 数据稍滞后'}
                                </p>
                            </>
                        ) : (
                            <p className="m-0 text-sm text-minor-ink">暂无数据</p>
                        )}
                    </CardContent>
                </Card>

                {/* Card 2: Last calendar month spend */}
                <Card as="article">
                    <CardHeader>
                        <CardTitle as="h3" className="text-sm font-medium text-muted-ink">
                            上月消费
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {lastMonth ? (
                            <>
                                <p className="m-0 text-3xl font-semibold text-navy tabular-nums">
                                    ¥{quotaToCny(lastMonth.totalUsedQuota).toFixed(2)}
                                </p>
                                <p className="mt-1.5 m-0 text-xs text-minor-ink tabular-nums">
                                    {lastMonth.totalCalls.toLocaleString('en-US')} 次调用
                                    {lastMonth.source === 'fallback' && ' · 数据稍滞后'}
                                </p>
                            </>
                        ) : (
                            <p className="m-0 text-sm text-minor-ink">暂无数据</p>
                        )}
                    </CardContent>
                </Card>

                {/* Card 3: All-time call count */}
                <Card as="article">
                    <CardHeader>
                        <CardTitle as="h3" className="text-sm font-medium text-muted-ink">
                            累计调用次数
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {allTime ? (
                            <>
                                <p className="m-0 text-3xl font-semibold text-navy tabular-nums">
                                    {allTime.totalCalls.toLocaleString('en-US')}
                                </p>
                                <p className="mt-1.5 m-0 text-xs text-minor-ink tabular-nums">
                                    共消费 ¥{quotaToCny(allTime.totalUsedQuota).toFixed(2)}
                                    {allTime.source === 'fallback' && ' · 数据稍滞后'}
                                </p>
                            </>
                        ) : (
                            <p className="m-0 text-sm text-minor-ink">暂无数据</p>
                        )}
                    </CardContent>
                </Card>

                {/* Card 4: Top 3 models in last 30 days */}
                <Card as="article">
                    <CardHeader>
                        <CardTitle as="h3" className="text-sm font-medium text-muted-ink">
                            最常用模型 · 近 30 天
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {top3 && top3.byModel.length > 0 ? (
                            <ul className="m-0 mt-1.5 p-0 list-none flex flex-col gap-1.5">
                                {top3.byModel.slice(0, 3).map((m) => {
                                    const pct = top3.totalUsedQuota
                                        ? (m.quota / top3.totalUsedQuota) * 100
                                        : 0;
                                    return (
                                        <li
                                            key={m.model}
                                            className="flex justify-between gap-2 text-xs text-ink"
                                        >
                                            <span
                                                className="font-mono overflow-hidden text-ellipsis whitespace-nowrap flex-1"
                                                title={m.model}
                                            >
                                                {m.model}
                                            </span>
                                            <span className="text-muted-ink tabular-nums whitespace-nowrap">
                                                {m.calls} 次 · {pct.toFixed(0)}%
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        ) : (
                            <p className="m-0 text-sm text-minor-ink">暂无调用</p>
                        )}
                    </CardContent>
                </Card>
            </div>

            <h2 className="m-0 mb-3 text-base font-semibold text-navy">快速操作</h2>
            <nav className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {QUICK_LINKS.map((link) => (
                    <Link
                        key={link.href}
                        href={link.href}
                        className={[
                            'block bg-surface border border-brand-border rounded-xl shadow-card',
                            'no-underline px-4 py-3.5',
                            'hover:border-brand-accent hover:shadow-card-strong',
                            'transition-all duration-150 ease-brand',
                        ].join(' ')}
                    >
                        <span className="block text-sm font-semibold text-navy">{link.label}</span>
                        <span className="block mt-0.5 text-xs text-muted-ink">{link.desc}</span>
                    </Link>
                ))}
            </nav>
        </section>
    );
}

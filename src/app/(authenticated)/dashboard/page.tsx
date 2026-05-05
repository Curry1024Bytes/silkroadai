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
 * render. Per-card error states are inline.
 */
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/session';
import { getQuotaWithCache } from '@/lib/newapi/quota-cache';
import { getUsageAggregate } from '@/lib/newapi/usage-aggregate';
import { quotaToCny, quotaToUsd } from '@/lib/newapi/client';

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

const cardStyle: React.CSSProperties = {
    background: '#fff',
    border: '1px solid #e5e8ee',
    borderRadius: 6,
    padding: 20,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
};

const cardLabelStyle: React.CSSProperties = {
    margin: '0 0 6px',
    fontSize: 12,
    color: '#5a6478',
};

const bigNumberStyle: React.CSSProperties = {
    margin: 0,
    fontSize: 28,
    color: '#0a1535',
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
};

const subtleStyle: React.CSSProperties = {
    margin: '6px 0 0',
    fontSize: 11,
    color: '#8a92a4',
    fontVariantNumeric: 'tabular-nums',
};

const emptyDataStyle: React.CSSProperties = {
    margin: 0,
    fontSize: 13,
    color: '#8a92a4',
};

const quickLinkStyle: React.CSSProperties = {
    flex: '1 1 140px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '14px 16px',
    background: '#fff',
    border: '1px solid #e5e8ee',
    borderRadius: 6,
    textDecoration: 'none',
    color: '#0a1535',
};

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

    // Four parallel fetches via allSettled — a single new-api blip on one
    // card doesn't take out the whole page. Per-card error states render
    // inline below.
    const [balanceSettled, lastMonthSettled, allTimeSettled, top3Settled] = await Promise.allSettled([
        getQuotaWithCache(user.id),
        newapiUserId != null
            ? getUsageAggregate({
                  portalUserId: user.id,
                  newapiUserId,
                  period: 'last_month',
              })
            : Promise.reject(new Error('account_not_provisioned')),
        newapiUserId != null
            ? getUsageAggregate({
                  portalUserId: user.id,
                  newapiUserId,
                  period: 'all',
              })
            : Promise.reject(new Error('account_not_provisioned')),
        newapiUserId != null
            ? getUsageAggregate({
                  portalUserId: user.id,
                  newapiUserId,
                  period: '30d',
              })
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
            <h1 style={{ margin: '0 0 8px', fontSize: 22, color: '#0a1535' }}>
                欢迎,{user.nickname || user.email.split('@')[0]}
            </h1>
            <p style={{ margin: '0 0 24px', fontSize: 13, color: '#5a6478' }}>
                这是您的客户后台。在这里管理 API Keys、查看余额与用量。
            </p>

            <div
                style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                    gap: 16,
                    marginBottom: 28,
                }}
            >
                {/* Card 1: Current balance */}
                <article style={cardStyle}>
                    <p style={cardLabelStyle}>当前余额</p>
                    {balance ? (
                        <>
                            <p style={bigNumberStyle}>
                                ¥{quotaToCny(balance.remain_quota).toFixed(2)}
                            </p>
                            <p style={subtleStyle}>
                                ≈ ${quotaToUsd(balance.remain_quota).toFixed(4)} USD
                                {balance.source === 'fallback' && ' · 数据稍滞后'}
                            </p>
                        </>
                    ) : (
                        <p style={emptyDataStyle}>暂无数据</p>
                    )}
                </article>

                {/* Card 2: Last calendar month spend */}
                <article style={cardStyle}>
                    <p style={cardLabelStyle}>上月消费</p>
                    {lastMonth ? (
                        <>
                            <p style={bigNumberStyle}>
                                ¥{quotaToCny(lastMonth.totalUsedQuota).toFixed(2)}
                            </p>
                            <p style={subtleStyle}>
                                {lastMonth.totalCalls.toLocaleString('en-US')} 次调用
                                {lastMonth.source === 'fallback' && ' · 数据稍滞后'}
                            </p>
                        </>
                    ) : (
                        <p style={emptyDataStyle}>暂无数据</p>
                    )}
                </article>

                {/* Card 3: All-time call count */}
                <article style={cardStyle}>
                    <p style={cardLabelStyle}>累计调用次数</p>
                    {allTime ? (
                        <>
                            <p style={bigNumberStyle}>
                                {allTime.totalCalls.toLocaleString('en-US')}
                            </p>
                            <p style={subtleStyle}>
                                共消费 ¥{quotaToCny(allTime.totalUsedQuota).toFixed(2)}
                                {allTime.source === 'fallback' && ' · 数据稍滞后'}
                            </p>
                        </>
                    ) : (
                        <p style={emptyDataStyle}>暂无数据</p>
                    )}
                </article>

                {/* Card 4: Top 3 models in last 30 days */}
                <article style={cardStyle}>
                    <p style={cardLabelStyle}>最常用模型 · 近 30 天</p>
                    {top3 && top3.byModel.length > 0 ? (
                        <ul
                            style={{
                                margin: '6px 0 0',
                                padding: 0,
                                listStyle: 'none',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 6,
                            }}
                        >
                            {top3.byModel.slice(0, 3).map((m) => {
                                const pct = top3.totalUsedQuota
                                    ? (m.quota / top3.totalUsedQuota) * 100
                                    : 0;
                                return (
                                    <li
                                        key={m.model}
                                        style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            gap: 8,
                                            fontSize: 12,
                                            color: '#1a2540',
                                        }}
                                    >
                                        <span
                                            style={{
                                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                                flex: 1,
                                            }}
                                            title={m.model}
                                        >
                                            {m.model}
                                        </span>
                                        <span
                                            style={{
                                                color: '#5a6478',
                                                fontVariantNumeric: 'tabular-nums',
                                                whiteSpace: 'nowrap',
                                            }}
                                        >
                                            {m.calls} 次 · {pct.toFixed(0)}%
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <p style={emptyDataStyle}>暂无调用</p>
                    )}
                </article>
            </div>

            <h2 style={{ margin: '0 0 12px', fontSize: 16, color: '#0a1535' }}>快速操作</h2>
            <nav
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 12,
                }}
            >
                {QUICK_LINKS.map((link) => (
                    <Link key={link.href} href={link.href} style={quickLinkStyle}>
                        <span style={{ fontSize: 14, fontWeight: 600 }}>{link.label}</span>
                        <span style={{ fontSize: 12, color: '#5a6478' }}>{link.desc}</span>
                    </Link>
                ))}
            </nav>
        </section>
    );
}

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
 * Streaming(P1 — 2026-08-29):本文件只是快壳 —— 只 await 本地 DB(充值
 * 流水 / reseller),立即渲染标题 / tabs / 表单 / 流水;慢区块(余额卡 +
 * 用量卡 / 图表 / 调用明细,依赖跨机 new-api)在 sections.tsx,由这里
 * kick off 共享 promise 后包 <Suspense> 流式补入。
 *
 * Resilience: balance, the usage aggregate, and the per-call log fetches are
 * independent — one failing degrades only its own section (暂无数据 / empty
 * state), never the whole page.
 */
import { Suspense } from 'react';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { fetchResellerStatus, type ResellerStatusSnap } from '@/lib/reseller/fetch-status';
import { ResellerPromoCard } from '@/components/reseller/ResellerPromoCard';
import { getLocale } from '@/lib/i18n/server';
import { intlLocale, pickMessages } from '@/lib/i18n';
import { commonMessages } from '@/lib/i18n/messages/common';
import { dashboardMessages } from '@/lib/i18n/messages/dashboard';
import { parsePeriod, type UsagePeriod } from './period';
import { PeriodTabs } from './period-tabs';
import { BalanceAlertForm } from './balance-alert-form';
import {
    BalanceNotices,
    BalanceStatCards,
    loadBalanceData,
    loadUsageData,
    StatCardSkeletons,
    UsageBody,
    UsageBodySkeleton,
    UsageStatCards,
} from './sections';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
    return { title: pickMessages(dashboardMessages, await getLocale()).pageTitle };
}

const HISTORY_LIMIT = 10;

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/dashboard', { method: 'GET', headers: { cookie } });
    return getCurrentUser(req);
}

export default async function DashboardPage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
    const user = await getSessionUser();
    // Layout already gated; this is just TS narrowing.
    if (!user) return null;

    const [params, locale] = await Promise.all([
        searchParams ?? Promise.resolve<Record<string, string | string[] | undefined>>({}),
        getLocale(),
    ]);
    const m = pickMessages(dashboardMessages, locale);
    const c = pickMessages(commonMessages, locale);
    const period: UsagePeriod = parsePeriod(params.period);
    const periodLabel = m.periods[period];
    const rechargeSources: Record<string, string> = m.rechargeSources;

    // Kick off 慢请求但【不 await】—— 壳只等下面的本地 DB;两个共享
    // promise 分别喂给多个 <Suspense> 区块(一次 fetch,多处消费),数据到
    // 了各区块独立流入。loader 永不 reject(resolve 带 error 标记的形状),
    // 一处失败不会炸掉共享它的其他 boundary。
    const balanceData = loadBalanceData(user.id);
    const usageData = loadUsageData({
        portalUserId: user.id,
        newapiUserId: user.newapi_user_id,
        newapiUsername: user.newapi_username,
        period,
        locale,
        m,
    });

    // ── 快壳数据:本地 DB 一波并行(fetchResellerStatus 与 layout 同请求
    // React.cache 去重,通常零成本)。失败降级为区块空态,不拖垮整页。 ──
    const [historySettled, resellerSettled] = await Promise.allSettled([
        prisma.rechargeLog.findMany({
            where: { user_id: user.id },
            orderBy: { created_at: 'desc' },
            take: HISTORY_LIMIT,
            select: { id: true, order_id: true, amount: true, source: true, created_at: true },
        }),
        fetchResellerStatus(user.id),
    ]);
    const history = historySettled.status === 'fulfilled' ? historySettled.value : [];
    if (historySettled.status === 'rejected') {
        console.warn(`[dashboard] rechargeLog history fetch failed for user ${user.id}:`, historySettled.reason);
    }
    const resellerSnap: ResellerStatusSnap =
        resellerSettled.status === 'fulfilled' ? resellerSettled.value : { status: null, isReseller: false };
    if (resellerSettled.status === 'rejected') {
        console.warn(`[dashboard] fetchResellerStatus failed for user ${user.id}:`, resellerSettled.reason);
    }

    return (
        <section>
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="m-0 mb-2 text-2xl font-semibold text-navy">
                        {m.welcome(user.nickname || user.email.split('@')[0])}
                    </h1>
                    <p className="m-0 text-sm text-muted-ink">{m.subtitle}</p>
                </div>
                <div className="flex items-center gap-3">
                    <PeriodTabs active={period} />
                    <Button href="/pay" size="sm">
                        {c.nav.topUp}
                    </Button>
                </div>
            </div>

            <Suspense fallback={null}>
                <BalanceNotices data={balanceData} m={m} locale={locale} />
            </Suspense>

            {/* 1. Summary cards(余额 2 张 + 用量 3 张各自独立流入) */}
            {/* 5 列只在 xl(≥1280)启用;lg 下每列不足 200px,数字太挤,退 3+2 两行。 */}
            <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
                <Suspense fallback={<StatCardSkeletons count={2} />}>
                    <BalanceStatCards data={balanceData} m={m} locale={locale} />
                </Suspense>
                <Suspense fallback={<StatCardSkeletons count={3} />}>
                    <UsageStatCards data={usageData} periodLabel={periodLabel} m={m} locale={locale} />
                </Suspense>
            </div>

            {/* 2-4. Chart + by-model + per-call table(同一份 usageData,整块流入) */}
            <Suspense fallback={<UsageBodySkeleton periodLabel={periodLabel} m={m} />}>
                <UsageBody data={usageData} periodLabel={periodLabel} m={m} locale={locale} />
            </Suspense>

            {/* 5. Balance alert threshold (preserved from /balance) */}
            <BalanceAlertForm
                initialThreshold={
                    user.balance_alert_threshold_cny != null ? Number(user.balance_alert_threshold_cny) : 10
                }
            />

            {/* 6. Recharge history (preserved from /balance) */}
            <h2 className="m-0 mb-3 text-base font-semibold text-navy">{m.recharge.heading}</h2>
            {history.length === 0 ? (
                <Card>
                    <EmptyState
                        title={m.recharge.emptyTitle}
                        body={
                            <>
                                {m.recharge.emptyBodyBefore}
                                <code className="font-mono text-xs">{c.nav.topUp}</code>
                                {m.recharge.emptyBodyAfter}
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
                                    {m.recharge.colAmount}
                                </th>
                                <th className="border-b border-brand-border px-4 py-2.5 text-left text-xs font-semibold">
                                    {m.recharge.colType}
                                </th>
                                <th className="border-b border-brand-border px-4 py-2.5 text-left text-xs font-semibold">
                                    {m.recharge.colOrder}
                                </th>
                                <th className="border-b border-brand-border px-4 py-2.5 text-left text-xs font-semibold">
                                    {m.recharge.colTime}
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
                                        <td className={cell}>{rechargeSources[row.source] ?? row.source}</td>
                                        <td className={`${cell} font-mono text-xs text-muted-ink`}>
                                            {row.order_id ? row.order_id.slice(0, 8) : '—'}
                                        </td>
                                        <td className={`${cell} text-muted-ink`}>
                                            {row.created_at.toLocaleString(intlLocale(locale), {
                                                timeZone: 'Asia/Shanghai',
                                            })}
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

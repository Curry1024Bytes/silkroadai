/**
 * /reseller/dashboard — reseller overview (PR-U2).
 *
 * Server component. Reads:
 *   - Reseller (tier + cumulative_gmv)
 *   - This month's commission aggregates (sum by status)
 *   - Total attributed customers
 *   - Active codes count
 *   - Last settlement row (if any)
 *
 * Same query shape as GET /api/portal/reseller/dashboard but inlined to
 * avoid the extra HTTP round-trip from a server component → its own API.
 *
 * Renders:
 *   - Tier badge + cumulative GMV
 *   - Progress bar toward next tier (or "已达最高档" for gold)
 *   - This-month strip: GMV / pending / confirmed
 *   - 4 quick-action cards (codes / customers / commissions / settlement)
 *   - Last settlement summary (if exists)
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/session';
import { fetchResellerStatus } from '@/lib/reseller/fetch-status';
import { prisma } from '@/lib/db';
import { tierProgress, type ResellerTierKey } from '@/lib/reseller/tier';
import { TierBadge } from '@/components/reseller/TierBadge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { DashboardViewBeacon } from './view-beacon';
import { getLocale } from '@/lib/i18n/server';
import { intlLocale, pickMessages, type Locale } from '@/lib/i18n';
import { resellerMessages } from '@/lib/i18n/messages/reseller';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
    return { title: pickMessages(resellerMessages, await getLocale()).meta.dashboardTitle };
}

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/reseller/dashboard', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

function currentMonthBounds(now: Date = new Date()): { start: Date; end: Date } {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    return {
        start: new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)),
        end: new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0)),
    };
}

function fmtCny(v: number, locale: Locale): string {
    return `¥${v.toLocaleString(intlLocale(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function ResellerDashboardPage() {
    const user = await getSessionUser();
    if (!user) return null;
    const status = await fetchResellerStatus(user.id);
    if (!status.isReseller) redirect('/reseller');

    // Reseller row + current-month aggregates + ancillary counts. 4 parallel queries.
    const reseller = await prisma.reseller.findUnique({ where: { user_id: user.id } });
    if (!reseller) redirect('/reseller');

    const { start, end } = currentMonthBounds();
    const [monthAgg, customersCount, activeCodesCount, lastSettlement, locale] = await Promise.all([
        prisma.resellerCommission.groupBy({
            by: ['status'],
            where: { reseller_id: reseller.id, created_at: { gte: start, lt: end } },
            _sum: { attributed_gmv: true, commission_amount: true },
        }),
        prisma.user.count({ where: { inviter_reseller_id: reseller.id } }),
        prisma.resellerInviteCode.count({ where: { reseller_id: reseller.id, is_active: true } }),
        prisma.resellerSettlement.findFirst({
            where: { reseller_id: reseller.id },
            orderBy: { period_month: 'desc' },
            select: { period_month: true, status: true, total_commission: true, paid_at: true },
        }),
        getLocale(),
    ]);
    const m = pickMessages(resellerMessages, locale).dashboard;
    const cny = (v: number) => fmtCny(v, locale);

    let monthGmv = 0;
    let monthPending = 0;
    let monthConfirmed = 0;
    for (const g of monthAgg) {
        const gmv = g._sum.attributed_gmv ? Number(g._sum.attributed_gmv) : 0;
        const commission = g._sum.commission_amount ? Number(g._sum.commission_amount) : 0;
        monthGmv += gmv;
        if (g.status === 'pending') monthPending += commission;
        if (g.status === 'confirmed') monthConfirmed += commission;
    }

    const cumulativeGmv = Number(reseller.cumulative_gmv);
    const progress = tierProgress(cumulativeGmv);

    return (
        <div className="space-y-6">
            <DashboardViewBeacon />

            {/* ── Hero card: tier + GMV + progress ── */}
            <Card>
                <CardHeader>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                        <div className="flex-1">
                            <p className="text-xs uppercase tracking-wider text-muted-ink m-0">{m.kicker}</p>
                            <CardTitle as="h1">{m.title}</CardTitle>
                        </div>
                        <TierBadge tier={reseller.tier as ResellerTierKey} size="md" locale={locale} />
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-baseline gap-3">
                        <p className="text-3xl font-semibold text-navy m-0">{cny(cumulativeGmv)}</p>
                        <span className="text-sm text-muted-ink">{m.cumulativeGmv}</span>
                    </div>
                    {progress ? (
                        <div className="space-y-2">
                            <div className="flex items-center justify-between text-xs text-muted-ink">
                                <span>
                                    {m.nextTierBefore}
                                    <strong className="text-navy">{progress.next.tier.toUpperCase()}</strong>
                                </span>
                                <span>{m.toAccumulate(cny(progress.gmvNeededToNextCny))}</span>
                            </div>
                            <div className="h-2 w-full bg-paper-muted rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-brand-accent transition-all"
                                    style={{
                                        // current tier's lower bound -> next tier's lower bound is the "span".
                                        // We display the % covered toward the NEXT tier.
                                        width: `${Math.min(
                                            100,
                                            Math.max(
                                                0,
                                                (1 -
                                                    progress.gmvNeededToNextCny /
                                                        Math.max(1, progress.next.minGmvCny)) *
                                                    100,
                                            ),
                                        ).toFixed(1)}%`,
                                    }}
                                    aria-hidden="true"
                                />
                            </div>
                        </div>
                    ) : (
                        <p className="text-sm text-muted-ink m-0">{m.topTier}</p>
                    )}
                </CardContent>
            </Card>

            {/* ── This-month strip ── */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Card>
                    <CardContent>
                        <p className="text-xs uppercase tracking-wider text-muted-ink m-0">{m.monthGmv}</p>
                        <p className="text-2xl font-semibold text-navy mt-1 mb-0">{cny(monthGmv)}</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent>
                        <p className="text-xs uppercase tracking-wider text-muted-ink m-0">{m.monthPending}</p>
                        <p className="text-2xl font-semibold text-amber-700 mt-1 mb-0">{cny(monthPending)}</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent>
                        <p className="text-xs uppercase tracking-wider text-muted-ink m-0">{m.monthConfirmed}</p>
                        <p className="text-2xl font-semibold text-emerald-700 mt-1 mb-0">{cny(monthConfirmed)}</p>
                    </CardContent>
                </Card>
            </div>

            {/* ── 4 quick action cards ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <QuickAction
                    href="/reseller/codes"
                    title={m.codesTitle(activeCodesCount)}
                    body={m.codesBody}
                    emoji="🎟️"
                />
                <QuickAction
                    href="/reseller/customers"
                    title={m.customersTitle(customersCount)}
                    body={m.customersBody}
                    emoji="👥"
                />
                <QuickAction
                    href="/reseller/commissions"
                    title={m.commissionsTitle}
                    body={m.commissionsBody}
                    emoji="💰"
                />
                <QuickAction
                    href="/reseller/settlement"
                    title={m.settlementTitle}
                    body={
                        lastSettlement
                            ? m.lastSettlement(lastSettlement.period_month, lastSettlement.status)
                            : m.noSettlement
                    }
                    emoji="🏦"
                />
            </div>
        </div>
    );
}

function QuickAction({ href, title, body, emoji }: { href: string; title: string; body: string; emoji: string }) {
    return (
        <Link
            href={href}
            className={[
                'group block rounded-xl border border-brand-border bg-surface px-5 py-4',
                'no-underline transition-all hover:border-brand-accent hover:shadow-card',
            ].join(' ')}
        >
            <div className="flex items-start gap-3">
                <span aria-hidden="true" className="text-2xl">
                    {emoji}
                </span>
                <div className="flex-1 min-w-0">
                    <p className="font-medium text-navy m-0 group-hover:text-brand-accent transition-colors">{title}</p>
                    <p className="text-xs text-muted-ink mt-1 mb-0">{body}</p>
                </div>
                <span aria-hidden="true" className="text-muted-ink group-hover:text-brand-accent">
                    →
                </span>
            </div>
        </Link>
    );
}

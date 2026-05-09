/**
 * /balance — current quota + recent recharge history.
 *
 * Server component:
 *   1. Get session user (layout already gated; we just need user.id).
 *   2. getQuotaWithCache(user.id) — 60s row cache backed by new-api getUser.
 *   3. prisma.rechargeLog.findMany — last 10 entries (W4-1 D1 design: row
 *      existence == success, no `status` field).
 *
 * UI shows CNY-converted figures (raw quota is implementation detail not
 * meaningful to customers). USD equivalent rendered as small subtitle.
 *
 * "fallback" source path renders a soft banner so the customer knows the
 * data may be stale (new-api unreachable but stale cache available).
 */
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { getQuotaWithCache, type QuotaSnapshot } from '@/lib/newapi/quota-cache';
import { quotaToCny, quotaToUsd } from '@/lib/newapi/client';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormError } from '@/components/ui/FormError';
import { BalanceAlertForm } from './balance-alert-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: '余额 — Silk Road AI' };

const HISTORY_LIMIT = 10;

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/balance', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

const SOURCE_LABEL: Record<string, string> = {
    payment: '在线支付',
    manual: '管理员充值',
    refund: '退款',
    promo: '推广奖励',
    adjustment: '余额调整',
};

export default async function BalancePage() {
    const user = await getSessionUser();
    if (!user) return null;

    let snapshot: QuotaSnapshot | null = null;
    let snapshotErr: string | null = null;
    try {
        snapshot = await getQuotaWithCache(user.id);
    } catch (err) {
        snapshotErr = err instanceof Error ? err.message : String(err);
    }

    const history = await prisma.rechargeLog.findMany({
        where: { user_id: user.id },
        orderBy: { created_at: 'desc' },
        take: HISTORY_LIMIT,
        select: {
            id: true,
            order_id: true,
            amount: true,
            source: true,
            created_at: true,
        },
    });

    return (
        <section>
            <div className="flex justify-between items-start gap-3 flex-wrap mb-5">
                <div>
                    <h1 className="m-0 mb-2 text-2xl font-semibold text-navy">余额</h1>
                    <p className="m-0 text-sm text-muted-ink">实时余额与充值流水。</p>
                </div>
                <Button href="/pay" size="sm">
                    + 充值
                </Button>
            </div>

            {snapshot?.source === 'fallback' && (
                <div
                    role="status"
                    className={[
                        'mb-4 px-4 py-2.5 rounded-lg text-xs',
                        'bg-status-warning-bg border border-status-warning-border text-status-warning-text',
                    ].join(' ')}
                >
                    数据暂时不可更新,显示的是稍早数据。
                </div>
            )}

            {snapshotErr ? (
                <div className="mb-6">
                    <FormError severity="banner">当前无法获取余额,请稍后重试。</FormError>
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                    <Card as="article">
                        <CardHeader>
                            <CardTitle as="h3" className="text-sm font-medium text-muted-ink">
                                可用余额
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p className="m-0 text-3xl font-semibold text-navy tabular-nums">
                                ¥{quotaToCny(snapshot!.remain_quota).toFixed(2)}
                            </p>
                            <p className="mt-1.5 m-0 text-xs text-minor-ink tabular-nums">
                                ≈ ${quotaToUsd(snapshot!.remain_quota).toFixed(4)} USD ·{' '}
                                {snapshot!.remain_quota.toLocaleString('en-US')} quota
                            </p>
                        </CardContent>
                    </Card>
                    <Card as="article">
                        <CardHeader>
                            <CardTitle as="h3" className="text-sm font-medium text-muted-ink">
                                累计消费
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p className="m-0 text-3xl font-semibold text-navy tabular-nums">
                                ¥{quotaToCny(snapshot!.used_quota).toFixed(2)}
                            </p>
                            <p className="mt-1.5 m-0 text-xs text-minor-ink tabular-nums">
                                ≈ ${quotaToUsd(snapshot!.used_quota).toFixed(4)} USD
                            </p>
                        </CardContent>
                    </Card>
                </div>
            )}

            {/* W6 D2: balance alert threshold settings. Renders between the
             *  cards and the recharge history so it's visible without
             *  scrolling. The Decimal column comes back from Prisma as
             *  Prisma.Decimal — Number() handles it; null defaults to 10
             *  (matches the schema default). */}
            <BalanceAlertForm
                initialThreshold={
                    user.balance_alert_threshold_cny != null ? Number(user.balance_alert_threshold_cny) : 10
                }
            />

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
                                <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                    金额(CNY)
                                </th>
                                <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                    类型
                                </th>
                                <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                    订单号
                                </th>
                                <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
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
                                        <td className={`${cell} tabular-nums font-medium`}>
                                            ¥{Number(row.amount).toFixed(2)}
                                        </td>
                                        <td className={cell}>{SOURCE_LABEL[row.source] ?? row.source}</td>
                                        <td className={`${cell} font-mono text-xs text-muted-ink`}>
                                            {row.order_id ? row.order_id.slice(0, 8) : '—'}
                                        </td>
                                        <td className={`${cell} text-muted-ink`}>
                                            {row.created_at.toLocaleString('zh-CN')}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </Card>
            )}
        </section>
    );
}

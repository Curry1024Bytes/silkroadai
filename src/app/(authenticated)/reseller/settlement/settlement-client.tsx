'use client';

/**
 * SettlementClient (PR-U2) — settlement request + history.
 *
 * Two interactive bits:
 *   1. "申请结算" button on a month — fires POST /api/portal/reseller/settlement/request
 *      with { month }. Disabled when:
 *        - confirmed_cny < min threshold (¥100)
 *        - pending_count > 0 (server will reject too — UX surface)
 *        - settle info incomplete (banner shown above)
 *   2. History list — purely display, status chips per row.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

export interface SettlementHistoryRow {
    id: string;
    period_month: string;
    total_commission_cny: number;
    commission_count: number;
    status: 'pending' | 'requested' | 'paid';
    requested_at: string | null;
    paid_at: string | null;
    paid_tx_ref: string | null;
    notes: string | null;
}

interface MonthAgg {
    period: string;
    confirmed_cny: number;
    confirmed_count: number;
    pending_count: number;
}

interface Props {
    settleInfoComplete: boolean;
    settleMethod: string | null;
    settleAccount: string | null;
    settleName: string | null;
    thisMonth: MonthAgg;
    prevMonth: MonthAgg;
    history: SettlementHistoryRow[];
    minThresholdCny: number;
}

function fmtCny(v: number): string {
    return `¥${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('zh-CN');
}

function fireAnalytics(eventType: string, properties: Record<string, unknown>): void {
    void fetch('/api/portal/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: eventType, properties }),
        credentials: 'same-origin',
    }).catch(() => {
        /* best-effort */
    });
}

export function SettlementClient(props: Props) {
    const {
        settleInfoComplete,
        settleMethod,
        settleAccount,
        settleName,
        thisMonth,
        prevMonth,
        history,
        minThresholdCny,
    } = props;

    return (
        <div className="space-y-4">
            {!settleInfoComplete && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
                    <p className="font-medium text-amber-900 m-0">⚠️ 请补全收款信息</p>
                    <p className="text-xs text-amber-800 mt-1 m-0">
                        提现需先填写收款方式 / 收款账号 / 收款人姓名。当前阶段请联系运营补全 (W11+ Phase 2 加自助编辑)。
                    </p>
                </div>
            )}
            {settleInfoComplete && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm">
                    <p className="font-medium text-emerald-900 m-0">收款信息已就绪</p>
                    <p className="text-xs text-emerald-800 mt-1 mb-0">
                        方式 {settleMethod} · 收款人 {settleName} · 账号 ****{settleAccount?.slice(-4)}
                    </p>
                </div>
            )}

            <Card>
                <CardHeader>
                    <div className="flex flex-col gap-1 flex-1">
                        <p className="text-xs uppercase tracking-wider text-muted-ink m-0">代理后台</p>
                        <CardTitle as="h1">结算</CardTitle>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-xs text-muted-ink m-0">
                        客户充值满 14 天进入&ldquo;可结算&rdquo;状态;单次申请满 {fmtCny(minThresholdCny)} 起结, 运营 7
                        个工作日内打款。
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <MonthCard
                            month={thisMonth}
                            label="本月"
                            minThresholdCny={minThresholdCny}
                            settleInfoComplete={settleInfoComplete}
                        />
                        <MonthCard
                            month={prevMonth}
                            label="上月"
                            minThresholdCny={minThresholdCny}
                            settleInfoComplete={settleInfoComplete}
                        />
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle as="h2">结算历史</CardTitle>
                </CardHeader>
                <CardContent>
                    {history.length === 0 ? (
                        <EmptyState
                            title="还没有结算记录"
                            body="每月初系统会自动生成上月可结算明细,你可以在上方卡片申请提现。"
                        />
                    ) : (
                        <ul className="space-y-2 list-none m-0 p-0">
                            {history.map((s) => (
                                <li key={s.id} className="rounded-xl border border-brand-border bg-surface px-4 py-3">
                                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                                        <div className="flex-1 min-w-0">
                                            <p className="font-medium text-navy m-0">
                                                {s.period_month}
                                                <span className="ml-2 text-xs text-muted-ink">
                                                    ({s.commission_count} 笔佣金)
                                                </span>
                                            </p>
                                            <p className="text-xs text-muted-ink mt-1 mb-0">
                                                {s.status === 'pending' && '待你申请'}
                                                {s.status === 'requested' &&
                                                    `已申请于 ${fmtDate(s.requested_at)} · 等待打款`}
                                                {s.status === 'paid' &&
                                                    `已打款 ${fmtDate(s.paid_at)}${
                                                        s.paid_tx_ref ? ' · 凭证 ' + s.paid_tx_ref : ''
                                                    }`}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <p className="text-base font-semibold text-emerald-700 m-0">
                                                {fmtCny(s.total_commission_cny)}
                                            </p>
                                            <SettlementStatusChip status={s.status} />
                                        </div>
                                    </div>
                                    {s.notes && <p className="text-xs text-muted-ink mt-2 mb-0">备注:{s.notes}</p>}
                                </li>
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

function MonthCard({
    month,
    label,
    minThresholdCny,
    settleInfoComplete,
}: {
    month: MonthAgg;
    label: string;
    minThresholdCny: number;
    settleInfoComplete: boolean;
}) {
    const router = useRouter();
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [submitted, setSubmitted] = useState(false);

    const belowMin = month.confirmed_cny < minThresholdCny;
    const hasPending = month.pending_count > 0;
    const disabled = belowMin || hasPending || !settleInfoComplete;
    const reason = !settleInfoComplete
        ? `请先补全收款信息`
        : belowMin
          ? `不足 ${fmtCny(minThresholdCny)} 起结线`
          : hasPending
            ? `该月还有 ${month.pending_count} 笔在 hold 期,不能申请`
            : '';

    async function handleSubmit() {
        setError(null);
        setSubmitting(true);
        try {
            const res = await fetch('/api/portal/reseller/settlement/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ month: month.period }),
                credentials: 'same-origin',
            });
            if (!res.ok) {
                const body: { error?: string; message?: string } = await res.json().catch(() => ({}));
                throw new Error(body.message || body.error || `服务端错误 (${res.status})`);
            }
            fireAnalytics('reseller_settlement_requested', {
                month: month.period,
                amount_cny: month.confirmed_cny,
            });
            setSubmitted(true);
            router.refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : '申请失败,请稍后重试');
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="rounded-xl border border-brand-border bg-paper-muted/30 px-4 py-3 space-y-3">
            <div className="flex items-baseline justify-between">
                <p className="text-xs uppercase tracking-wider text-muted-ink m-0">
                    {label} · {month.period}
                </p>
                {month.pending_count > 0 && (
                    <span className="text-xs text-amber-700">{month.pending_count} 笔待确认</span>
                )}
            </div>
            <p className="text-2xl font-semibold text-emerald-700 m-0">{fmtCny(month.confirmed_cny)}</p>
            <p className="text-xs text-muted-ink m-0">{month.confirmed_count} 笔可结算佣金</p>
            <div title={reason} className="inline-block">
                <Button
                    type="button"
                    onClick={handleSubmit}
                    disabled={disabled || submitting || submitted}
                    size="sm"
                    variant={submitted ? 'secondary' : 'primary'}
                >
                    {submitted ? '✓ 已申请' : submitting ? '提交中...' : '申请结算'}
                </Button>
            </div>
            {disabled && reason && <p className="text-xs text-muted-ink m-0">{reason}</p>}
            {error && <p className="text-xs text-red-700 m-0">{error}</p>}
        </div>
    );
}

function SettlementStatusChip({ status }: { status: 'pending' | 'requested' | 'paid' }) {
    if (status === 'paid') {
        return <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800">已打款</span>;
    }
    if (status === 'requested') {
        return <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-800">等待打款</span>;
    }
    return <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">待申请</span>;
}

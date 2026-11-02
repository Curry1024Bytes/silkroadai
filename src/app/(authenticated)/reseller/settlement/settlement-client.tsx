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
import { useLocale, useMessages } from '@/lib/i18n/client';
import { intlLocale, type Locale } from '@/lib/i18n';
import { resellerMessages } from '@/lib/i18n/messages/reseller';

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

function fmtCny(v: number, locale: Locale): string {
    return `¥${v.toLocaleString(intlLocale(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso: string | null, locale: Locale): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(intlLocale(locale), { timeZone: 'Asia/Shanghai' });
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
    const locale = useLocale();
    const all = useMessages(resellerMessages);
    const m = all.settlement;
    const cny = (v: number) => fmtCny(v, locale);
    const date = (iso: string | null) => fmtDate(iso, locale);

    return (
        <div className="space-y-4">
            {!settleInfoComplete && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
                    <p className="font-medium text-amber-900 m-0">{m.incompleteTitle}</p>
                    <p className="text-xs text-amber-800 mt-1 m-0">{m.incompleteBody}</p>
                </div>
            )}
            {settleInfoComplete && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm">
                    <p className="font-medium text-emerald-900 m-0">{m.readyTitle}</p>
                    <p className="text-xs text-emerald-800 mt-1 mb-0">
                        {m.readyBody(settleMethod ?? '', settleName ?? '', settleAccount?.slice(-4) ?? '')}
                    </p>
                </div>
            )}

            <Card>
                <CardHeader>
                    <div className="flex flex-col gap-1 flex-1">
                        <p className="text-xs uppercase tracking-wider text-muted-ink m-0">
                            {all.common.consoleKicker}
                        </p>
                        <CardTitle as="h1">{m.title}</CardTitle>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-xs text-muted-ink m-0">{m.intro(cny(minThresholdCny))}</p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <MonthCard
                            month={thisMonth}
                            label={m.thisMonth}
                            minThresholdCny={minThresholdCny}
                            settleInfoComplete={settleInfoComplete}
                        />
                        <MonthCard
                            month={prevMonth}
                            label={m.prevMonth}
                            minThresholdCny={minThresholdCny}
                            settleInfoComplete={settleInfoComplete}
                        />
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle as="h2">{m.historyTitle}</CardTitle>
                </CardHeader>
                <CardContent>
                    {history.length === 0 ? (
                        <EmptyState title={m.emptyTitle} body={m.emptyBody} />
                    ) : (
                        <ul className="space-y-2 list-none m-0 p-0">
                            {history.map((s) => (
                                <li key={s.id} className="rounded-xl border border-brand-border bg-surface px-4 py-3">
                                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                                        <div className="flex-1 min-w-0">
                                            <p className="font-medium text-navy m-0">
                                                {s.period_month}
                                                <span className="ml-2 text-xs text-muted-ink">
                                                    {m.commissionCount(s.commission_count)}
                                                </span>
                                            </p>
                                            <p className="text-xs text-muted-ink mt-1 mb-0">
                                                {s.status === 'pending' && m.awaitingRequest}
                                                {s.status === 'requested' && m.requestedOn(date(s.requested_at))}
                                                {s.status === 'paid' && m.paidOn(date(s.paid_at), s.paid_tx_ref)}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <p className="text-base font-semibold text-emerald-700 m-0">
                                                {cny(s.total_commission_cny)}
                                            </p>
                                            <SettlementStatusChip status={s.status} />
                                        </div>
                                    </div>
                                    {s.notes && <p className="text-xs text-muted-ink mt-2 mb-0">{m.notes(s.notes)}</p>}
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
    const locale = useLocale();
    const all = useMessages(resellerMessages);
    const m = all.settlement;
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [submitted, setSubmitted] = useState(false);

    const belowMin = month.confirmed_cny < minThresholdCny;
    const hasPending = month.pending_count > 0;
    const disabled = belowMin || hasPending || !settleInfoComplete;
    const reason = !settleInfoComplete
        ? m.reasonIncomplete
        : belowMin
          ? m.reasonBelowMin(fmtCny(minThresholdCny, locale))
          : hasPending
            ? m.reasonPending(month.pending_count)
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
                throw new Error(body.message || body.error || all.common.serverError(res.status));
            }
            fireAnalytics('reseller_settlement_requested', {
                month: month.period,
                amount_cny: month.confirmed_cny,
            });
            setSubmitted(true);
            router.refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : m.requestFailed);
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
                    <span className="text-xs text-amber-700">{m.pendingCount(month.pending_count)}</span>
                )}
            </div>
            <p className="text-2xl font-semibold text-emerald-700 m-0">{fmtCny(month.confirmed_cny, locale)}</p>
            <p className="text-xs text-muted-ink m-0">{m.confirmedCount(month.confirmed_count)}</p>
            <div title={reason} className="inline-block">
                <Button
                    type="button"
                    onClick={handleSubmit}
                    disabled={disabled || submitting || submitted}
                    size="sm"
                    variant={submitted ? 'secondary' : 'primary'}
                >
                    {submitted ? m.submitted : submitting ? m.submitting : m.request}
                </Button>
            </div>
            {disabled && reason && <p className="text-xs text-muted-ink m-0">{reason}</p>}
            {error && <p className="text-xs text-red-700 m-0">{error}</p>}
        </div>
    );
}

function SettlementStatusChip({ status }: { status: 'pending' | 'requested' | 'paid' }) {
    const m = useMessages(resellerMessages).settlement;
    if (status === 'paid') {
        return <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800">{m.chipPaid}</span>;
    }
    if (status === 'requested') {
        return <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-800">{m.chipRequested}</span>;
    }
    return <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">{m.chipPending}</span>;
}

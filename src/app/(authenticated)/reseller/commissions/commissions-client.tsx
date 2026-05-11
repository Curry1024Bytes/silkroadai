'use client';

/**
 * CommissionsClient (PR-U2) — summary cards + tabs + table.
 *
 * Filters are URL-driven (?status=&month=&page=) so this stays purely
 * presentational. Tab clicks update window.location via <Link> — no
 * client state needed.
 */
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';

export type StatusFilter = 'all' | 'pending' | 'confirmed' | 'settled';

export interface CommissionRow {
    id: string;
    customer_email_masked: string;
    attributed_gmv_cny: number;
    commission_rate: number;
    commission_amount_cny: number;
    status: 'pending' | 'confirmed' | 'settled';
    admin_review_required: boolean;
    hold_until: string;
    settled_at: string | null;
    created_at: string;
}

interface Props {
    rows: CommissionRow[];
    summary: {
        gmv_cny: number;
        pending_cny: number;
        confirmed_cny: number;
        settled_cny: number;
        count_pending: number;
        count_confirmed: number;
        count_settled: number;
    };
    filters: { status: StatusFilter; month: string | null };
    pagination: { page: number; limit: number; total: number; hasMore: boolean };
}

function fmtCny(v: number): string {
    return `¥${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('zh-CN');
}

function buildHref(status: StatusFilter, month: string | null, page = 1): string {
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (month) params.set('month', month);
    if (page > 1) params.set('page', String(page));
    const qs = params.toString();
    return qs ? `/reseller/commissions?${qs}` : '/reseller/commissions';
}

export function CommissionsClient({ rows, summary, filters, pagination }: Props) {
    const tabs: { key: StatusFilter; label: string; count?: number; sum?: number }[] = [
        {
            key: 'all',
            label: '全部',
            count: summary.count_pending + summary.count_confirmed + summary.count_settled,
        },
        { key: 'pending', label: '待确认', count: summary.count_pending, sum: summary.pending_cny },
        { key: 'confirmed', label: '可结算', count: summary.count_confirmed, sum: summary.confirmed_cny },
        { key: 'settled', label: '已结算', count: summary.count_settled, sum: summary.settled_cny },
    ];

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <div className="flex flex-col gap-1 flex-1">
                        <p className="text-xs uppercase tracking-wider text-muted-ink m-0">代理后台</p>
                        <CardTitle as="h1">佣金明细</CardTitle>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    {/* Summary strip */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                        <Summary label="累计 GMV" value={fmtCny(summary.gmv_cny)} />
                        <Summary label="待确认" value={fmtCny(summary.pending_cny)} accent="amber" />
                        <Summary label="可结算" value={fmtCny(summary.confirmed_cny)} accent="emerald" />
                        <Summary label="已结算" value={fmtCny(summary.settled_cny)} accent="slate" />
                    </div>

                    {/* Tabs */}
                    <div className="flex gap-2 flex-wrap border-b border-brand-border">
                        {tabs.map((t) => {
                            const active = filters.status === t.key;
                            return (
                                <Link
                                    key={t.key}
                                    href={buildHref(t.key, filters.month)}
                                    className={[
                                        'px-3 py-2 text-sm no-underline transition-colors',
                                        active
                                            ? 'text-navy font-semibold border-b-2 border-brand-accent -mb-px'
                                            : 'text-muted-ink hover:text-navy border-b-2 border-transparent',
                                    ].join(' ')}
                                >
                                    {t.label}
                                    {typeof t.count === 'number' && (
                                        <span className="ml-1 text-xs text-muted-ink">({t.count})</span>
                                    )}
                                </Link>
                            );
                        })}
                    </div>

                    {rows.length === 0 ? (
                        <EmptyState title="没有佣金记录" body="客户充值后,这里会按时间倒序显示每一笔佣金。" />
                    ) : (
                        <>
                            {/* Mobile cards */}
                            <ul className="md:hidden space-y-2 list-none m-0 p-0">
                                {rows.map((r) => (
                                    <li
                                        key={r.id}
                                        className="rounded-xl border border-brand-border bg-surface px-4 py-3"
                                    >
                                        <div className="flex items-baseline justify-between">
                                            <span className="text-xs text-muted-ink">{fmtDate(r.created_at)}</span>
                                            <CommissionStatusChip status={r.status} hold={r.hold_until} />
                                        </div>
                                        <p className="font-medium text-navy mt-1 mb-0">{r.customer_email_masked}</p>
                                        <div className="flex justify-between items-baseline mt-2">
                                            <p className="text-xs text-muted-ink m-0">
                                                充值 {fmtCny(r.attributed_gmv_cny)} ·{' '}
                                                {(r.commission_rate * 100).toFixed(0)}%
                                            </p>
                                            <p className="text-base font-semibold text-emerald-700 m-0">
                                                {fmtCny(r.commission_amount_cny)}
                                            </p>
                                        </div>
                                        {r.admin_review_required && (
                                            <p className="text-xs text-amber-700 mt-2 mb-0">⚠️ 单笔超阈值,需运营审核</p>
                                        )}
                                    </li>
                                ))}
                            </ul>

                            {/* Desktop table */}
                            <div className="hidden md:block overflow-x-auto">
                                <table className="w-full text-sm border-collapse">
                                    <thead>
                                        <tr className="text-left text-xs uppercase tracking-wider text-muted-ink">
                                            <th className="font-medium px-3 py-2 border-b border-brand-border">时间</th>
                                            <th className="font-medium px-3 py-2 border-b border-brand-border">客户</th>
                                            <th className="font-medium px-3 py-2 border-b border-brand-border">充值</th>
                                            <th className="font-medium px-3 py-2 border-b border-brand-border">费率</th>
                                            <th className="font-medium px-3 py-2 border-b border-brand-border">佣金</th>
                                            <th className="font-medium px-3 py-2 border-b border-brand-border">状态</th>
                                            <th className="font-medium px-3 py-2 border-b border-brand-border">
                                                Hold 到
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map((r) => (
                                            <tr key={r.id} className="hover:bg-paper-muted/30">
                                                <td className="px-3 py-2 border-b border-brand-border text-xs text-muted-ink">
                                                    {fmtDate(r.created_at)}
                                                </td>
                                                <td className="px-3 py-2 border-b border-brand-border">
                                                    {r.customer_email_masked}
                                                </td>
                                                <td className="px-3 py-2 border-b border-brand-border">
                                                    {fmtCny(r.attributed_gmv_cny)}
                                                </td>
                                                <td className="px-3 py-2 border-b border-brand-border">
                                                    {(r.commission_rate * 100).toFixed(0)}%
                                                </td>
                                                <td className="px-3 py-2 border-b border-brand-border font-medium text-emerald-700">
                                                    {fmtCny(r.commission_amount_cny)}
                                                </td>
                                                <td className="px-3 py-2 border-b border-brand-border">
                                                    <CommissionStatusChip
                                                        status={r.status}
                                                        hold={r.hold_until}
                                                        adminReview={r.admin_review_required}
                                                    />
                                                </td>
                                                <td className="px-3 py-2 border-b border-brand-border text-xs text-muted-ink">
                                                    {r.status === 'pending' ? fmtDate(r.hold_until) : '—'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            {pagination.total > pagination.limit && (
                                <div className="flex items-center justify-between pt-3 border-t border-brand-border">
                                    <span className="text-xs text-muted-ink">
                                        第 {pagination.page} 页 · 共 {pagination.total} 笔
                                    </span>
                                    <div className="flex gap-2">
                                        {pagination.page > 1 && (
                                            <Link
                                                href={buildHref(filters.status, filters.month, pagination.page - 1)}
                                                className="px-3 py-1.5 text-sm rounded-lg border border-brand-border hover:bg-paper-muted no-underline text-navy"
                                            >
                                                ← 上一页
                                            </Link>
                                        )}
                                        {pagination.hasMore && (
                                            <Link
                                                href={buildHref(filters.status, filters.month, pagination.page + 1)}
                                                className="px-3 py-1.5 text-sm rounded-lg border border-brand-border hover:bg-paper-muted no-underline text-navy"
                                            >
                                                下一页 →
                                            </Link>
                                        )}
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

function Summary({ label, value, accent }: { label: string; value: string; accent?: 'amber' | 'emerald' | 'slate' }) {
    const tone =
        accent === 'amber'
            ? 'text-amber-700'
            : accent === 'emerald'
              ? 'text-emerald-700'
              : accent === 'slate'
                ? 'text-slate-700'
                : 'text-navy';
    return (
        <div className="rounded-lg bg-paper-muted/40 px-3 py-2 border border-transparent">
            <p className="text-[10px] uppercase tracking-wider text-muted-ink m-0">{label}</p>
            <p className={`text-base font-semibold m-0 ${tone}`}>{value}</p>
        </div>
    );
}

function CommissionStatusChip({
    status,
    hold: _hold,
    adminReview,
}: {
    status: 'pending' | 'confirmed' | 'settled';
    hold: string;
    adminReview?: boolean;
}) {
    if (adminReview && status === 'pending') {
        return <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-800">审核中</span>;
    }
    if (status === 'pending') {
        return <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-800">待确认</span>;
    }
    if (status === 'confirmed') {
        return <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800">可结算</span>;
    }
    return <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">已结算</span>;
}

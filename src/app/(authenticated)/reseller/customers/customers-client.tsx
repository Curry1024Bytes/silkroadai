'use client';

/**
 * CustomersClient (PR-U2) — table on desktop, card-stack on mobile.
 *
 * Pure presentation; pagination is URL-driven (?page=N) so the server
 * component re-renders with fresh data on navigation. We don't refetch
 * client-side — keeps the data path simple.
 */
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { useLocale, useMessages } from '@/lib/i18n/client';
import { intlLocale, type Locale } from '@/lib/i18n';
import { resellerMessages } from '@/lib/i18n/messages/reseller';

export interface CustomerRow {
    seq_no: string;
    email_masked: string;
    joined_at: string;
    attribution_expires_at: string | null;
    attribution_active: boolean;
    total_recharged_cny: number;
    last_recharge_at: string | null;
    status: 'active' | 'disabled' | 'banned';
    inviter_code: string | null;
}

interface Props {
    rows: CustomerRow[];
    pagination: { page: number; limit: number; total: number; hasMore: boolean };
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

export function CustomersClient({ rows, pagination }: Props) {
    const locale = useLocale();
    const all = useMessages(resellerMessages);
    const m = all.customers;
    const cny = (v: number) => fmtCny(v, locale);
    const date = (iso: string | null) => fmtDate(iso, locale);

    if (rows.length === 0) {
        return (
            <Card>
                <CardContent>
                    <EmptyState
                        title={m.emptyTitle}
                        body={m.emptyBody}
                        action={
                            <Link
                                href="/reseller/codes"
                                className="inline-block px-4 py-2 text-sm rounded-lg bg-navy text-paper no-underline hover:bg-navy-strong"
                            >
                                {m.emptyCta}
                            </Link>
                        }
                    />
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-col gap-1 flex-1">
                    <p className="text-xs uppercase tracking-wider text-muted-ink m-0">{all.common.consoleKicker}</p>
                    <CardTitle as="h1">{m.title(pagination.total)}</CardTitle>
                </div>
            </CardHeader>
            <CardContent className="space-y-3">
                {/* Mobile card-stack (default), desktop hides */}
                <ul className="md:hidden space-y-2 list-none m-0 p-0">
                    {rows.map((r) => (
                        <li key={r.seq_no} className="rounded-xl border border-brand-border bg-surface px-4 py-3">
                            <div className="flex items-baseline justify-between">
                                <span className="text-xs font-mono text-muted-ink">{r.seq_no}</span>
                                <StatusChip status={r.status} active={r.attribution_active} />
                            </div>
                            <p className="font-medium text-navy mt-1 mb-0">{r.email_masked}</p>
                            <div className="grid grid-cols-2 gap-2 mt-2 text-xs text-muted-ink">
                                <div>
                                    <p className="text-[10px] uppercase tracking-wider m-0">{m.joined}</p>
                                    <p className="m-0">{date(r.joined_at)}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] uppercase tracking-wider m-0">{m.totalRecharged}</p>
                                    <p className="m-0 text-navy font-medium">{cny(r.total_recharged_cny)}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] uppercase tracking-wider m-0">{m.attributionExpires}</p>
                                    <p className="m-0">{date(r.attribution_expires_at)}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] uppercase tracking-wider m-0">{m.lastRecharge}</p>
                                    <p className="m-0">{date(r.last_recharge_at)}</p>
                                </div>
                            </div>
                            {r.inviter_code && (
                                <p className="text-xs text-muted-ink mt-2 mb-0">
                                    {m.usedCode}
                                    <code className="font-mono">{r.inviter_code}</code>
                                </p>
                            )}
                        </li>
                    ))}
                </ul>

                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr className="text-left text-xs uppercase tracking-wider text-muted-ink">
                                <th className="font-medium px-3 py-2 border-b border-brand-border">{m.thSeq}</th>
                                <th className="font-medium px-3 py-2 border-b border-brand-border">{m.thEmail}</th>
                                <th className="font-medium px-3 py-2 border-b border-brand-border">{m.joined}</th>
                                <th className="font-medium px-3 py-2 border-b border-brand-border">
                                    {m.attributionExpires}
                                </th>
                                <th className="font-medium px-3 py-2 border-b border-brand-border">
                                    {m.totalRecharged}
                                </th>
                                <th className="font-medium px-3 py-2 border-b border-brand-border">{m.lastRecharge}</th>
                                <th className="font-medium px-3 py-2 border-b border-brand-border">{m.thCode}</th>
                                <th className="font-medium px-3 py-2 border-b border-brand-border">{m.thStatus}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r) => (
                                <tr key={r.seq_no} className="hover:bg-paper-muted/30">
                                    <td className="px-3 py-2 border-b border-brand-border font-mono text-xs">
                                        {r.seq_no}
                                    </td>
                                    <td className="px-3 py-2 border-b border-brand-border">{r.email_masked}</td>
                                    <td className="px-3 py-2 border-b border-brand-border text-xs text-muted-ink">
                                        {date(r.joined_at)}
                                    </td>
                                    <td className="px-3 py-2 border-b border-brand-border text-xs text-muted-ink">
                                        {date(r.attribution_expires_at)}
                                    </td>
                                    <td className="px-3 py-2 border-b border-brand-border font-medium text-navy">
                                        {cny(r.total_recharged_cny)}
                                    </td>
                                    <td className="px-3 py-2 border-b border-brand-border text-xs text-muted-ink">
                                        {date(r.last_recharge_at)}
                                    </td>
                                    <td className="px-3 py-2 border-b border-brand-border text-xs font-mono">
                                        {r.inviter_code ?? '—'}
                                    </td>
                                    <td className="px-3 py-2 border-b border-brand-border">
                                        <StatusChip status={r.status} active={r.attribution_active} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {pagination.total > pagination.limit && (
                    <div className="flex items-center justify-between pt-3 border-t border-brand-border">
                        <span className="text-xs text-muted-ink">{m.pageInfo(pagination.page, pagination.total)}</span>
                        <div className="flex gap-2">
                            {pagination.page > 1 && (
                                <Link
                                    href={`/reseller/customers?page=${pagination.page - 1}`}
                                    className="px-3 py-1.5 text-sm rounded-lg border border-brand-border hover:bg-paper-muted no-underline text-navy"
                                >
                                    {all.common.prevPage}
                                </Link>
                            )}
                            {pagination.hasMore && (
                                <Link
                                    href={`/reseller/customers?page=${pagination.page + 1}`}
                                    className="px-3 py-1.5 text-sm rounded-lg border border-brand-border hover:bg-paper-muted no-underline text-navy"
                                >
                                    {all.common.nextPage}
                                </Link>
                            )}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function StatusChip({ status, active }: { status: 'active' | 'disabled' | 'banned'; active: boolean }) {
    const m = useMessages(resellerMessages).customers;
    if (status === 'banned') {
        return <span className="text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-800">{m.chipBanned}</span>;
    }
    if (status === 'disabled') {
        return <span className="text-xs px-2 py-0.5 rounded-full bg-paper-muted text-muted-ink">{m.chipDisabled}</span>;
    }
    if (!active) {
        return (
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-800">
                {m.chipAttributionEnded}
            </span>
        );
    }
    return <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800">{m.chipAttributing}</span>;
}

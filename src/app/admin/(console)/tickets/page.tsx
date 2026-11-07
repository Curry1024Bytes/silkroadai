'use client';

/** /admin/tickets — 客诉工单队列(PR2)。 */
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import type { TicketCategory, TicketStatus } from '@prisma/client';
import PayPageLayout from '@/components/PayPageLayout';
import { resolveLocale } from '@/lib/locale';
import { pickMessages } from '@/lib/i18n';
import { adminTicketsMessages } from '@/lib/i18n/messages/admin-tickets';
import { ticketsMessages } from '@/lib/i18n/messages/tickets';
import { TICKET_CATEGORIES } from '@/lib/tickets/status';
import type { AdminTicketRow } from '@/lib/tickets/admin-service';
import type { TicketSlaStats } from '@/lib/tickets/sla';
import { adminQuery, fmtTime, hoursSince, PRIORITY_PILL, STATUS_PILL } from './shared';

type Tab = TicketStatus | 'all';
const TABS: Tab[] = ['open', 'waiting_customer', 'resolved', 'closed', 'all'];

function TicketsQueue() {
    const sp = useSearchParams();
    const locale = resolveLocale(sp.get('lang'));
    const isDark = (sp.get('theme') || 'light') === 'dark';
    const isEmbedded = (sp.get('ui_mode') || 'standalone') === 'embedded';
    const m = pickMessages(adminTicketsMessages, locale);
    const tm = pickMessages(ticketsMessages, locale);
    const qs = adminQuery(sp);

    const [tab, setTab] = useState<Tab>('open');
    const [category, setCategory] = useState<TicketCategory | ''>('');
    const [q, setQ] = useState('');
    const [query, setQuery] = useState('');
    const [page, setPage] = useState(1);
    const [items, setItems] = useState<AdminTicketRow[]>([]);
    const [total, setTotal] = useState(0);
    const [counts, setCounts] = useState<Record<string, number>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [sla, setSla] = useState<TicketSlaStats | null>(null);
    const [slaEdit, setSlaEdit] = useState<{ firstReplyHours: string; resolveHours: string } | null>(null);
    const [slaSaving, setSlaSaving] = useState(false);

    const fetchSla = useCallback(async () => {
        try {
            const res = await fetch('/api/admin/tickets/sla', { credentials: 'same-origin' });
            if (res.ok) setSla(((await res.json()) as { sla: TicketSlaStats }).sla);
        } catch {
            /* SLA 条是附属信息,失败静默 */
        }
    }, []);

    async function saveSla() {
        if (!slaEdit) return;
        setSlaSaving(true);
        try {
            const res = await fetch('/api/admin/tickets/sla', {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    firstReplyHours: Number(slaEdit.firstReplyHours),
                    resolveHours: Number(slaEdit.resolveHours),
                }),
            });
            if (!res.ok) {
                setError(m.sla.saveFailed);
                return;
            }
            setSla(((await res.json()) as { sla: TicketSlaStats }).sla);
            setSlaEdit(null);
        } catch {
            setError(m.sla.saveFailed);
        } finally {
            setSlaSaving(false);
        }
    }

    const fetchList = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const p = new URLSearchParams({ status: tab, page: String(page) });
            if (category) p.set('category', category);
            if (query) p.set('q', query);
            const res = await fetch(`/api/admin/tickets?${p.toString()}`, { credentials: 'same-origin' });
            if (res.status === 401) {
                setError(m.sessionExpired);
                return;
            }
            if (!res.ok) throw new Error(String(res.status));
            const data = (await res.json()) as {
                items: AdminTicketRow[];
                total: number;
                counts: Record<string, number>;
            };
            setItems(data.items);
            setTotal(data.total);
            setCounts(data.counts);
        } catch {
            setError(m.loadFailed);
        } finally {
            setLoading(false);
        }
    }, [tab, category, query, page, m.sessionExpired, m.loadFailed]);

    useEffect(() => {
        void fetchList();
    }, [fetchList]);
    useEffect(() => {
        void fetchSla();
    }, [fetchSla]);

    const btn = [
        'inline-flex items-center rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
        isDark
            ? 'border-slate-600 text-slate-200 hover:bg-slate-800'
            : 'border-slate-300 text-slate-700 hover:bg-slate-100',
    ].join(' ');
    const input = [
        'rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50',
        isDark ? 'border-slate-600 bg-slate-700 text-slate-100' : 'border-slate-300 bg-white text-slate-900',
    ].join(' ');
    const link = isDark ? 'text-indigo-400 hover:underline' : 'text-indigo-600 hover:underline';
    const muted = isDark ? 'text-slate-400' : 'text-gray-500';

    return (
        <PayPageLayout
            isDark={isDark}
            isEmbedded={isEmbedded}
            maxWidth="full"
            title={m.title}
            subtitle={m.subtitle}
            locale={locale}
            actions={
                <button type="button" onClick={() => void fetchList()} className={btn}>
                    {m.refresh}
                </button>
            }
        >
            {error && (
                <div
                    className={`mb-4 rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/50 text-red-400' : 'border-red-200 bg-red-50 text-red-600'}`}
                >
                    {error}
                </div>
            )}

            {sla ? (
                <div className={`mb-3 flex flex-wrap items-center gap-3 text-xs ${muted}`} data-testid="sla-bar">
                    <span className="font-medium">{m.sla.label}</span>
                    {slaEdit ? (
                        <>
                            <label className="flex items-center gap-1">
                                {m.sla.firstReply}
                                <input
                                    type="number"
                                    min={1}
                                    max={720}
                                    value={slaEdit.firstReplyHours}
                                    onChange={(e) => setSlaEdit({ ...slaEdit, firstReplyHours: e.target.value })}
                                    className={`${input} w-20`}
                                />
                            </label>
                            <label className="flex items-center gap-1">
                                {m.sla.resolve}
                                <input
                                    type="number"
                                    min={1}
                                    max={720}
                                    value={slaEdit.resolveHours}
                                    onChange={(e) => setSlaEdit({ ...slaEdit, resolveHours: e.target.value })}
                                    className={`${input} w-20`}
                                />
                            </label>
                            <button type="button" className={btn} disabled={slaSaving} onClick={() => void saveSla()}>
                                {m.sla.save}
                            </button>
                            <button type="button" className={btn} disabled={slaSaving} onClick={() => setSlaEdit(null)}>
                                {m.sla.cancel}
                            </button>
                        </>
                    ) : (
                        <>
                            <span>{m.sla.summary(sla.firstReplyHours, sla.resolveHours)}</span>
                            <span
                                className={
                                    sla.breachedFirstReply + sla.breachedResolve > 0 ? 'font-semibold text-red-500' : ''
                                }
                            >
                                {m.sla.breached(sla.breachedFirstReply, sla.breachedResolve)}
                            </span>
                            <button
                                type="button"
                                className={btn}
                                onClick={() =>
                                    setSlaEdit({
                                        firstReplyHours: String(sla.firstReplyHours),
                                        resolveHours: String(sla.resolveHours),
                                    })
                                }
                            >
                                {m.sla.edit}
                            </button>
                        </>
                    )}
                </div>
            ) : null}

            <div className="mb-3 flex flex-wrap items-center gap-2">
                <div
                    className={`flex rounded-lg border p-0.5 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}
                    role="tablist"
                >
                    {TABS.map((t) => (
                        <button
                            key={t}
                            type="button"
                            role="tab"
                            aria-selected={tab === t}
                            onClick={() => {
                                setTab(t);
                                setPage(1);
                            }}
                            className={[
                                'rounded-md px-3 py-1 text-xs font-medium',
                                tab === t
                                    ? 'bg-emerald-500 text-white'
                                    : isDark
                                      ? 'text-slate-300 hover:bg-slate-800'
                                      : 'text-slate-600 hover:bg-slate-100',
                            ].join(' ')}
                        >
                            {m.tabs[t]}
                            {t !== 'all' && counts[t] != null ? (
                                <span className="ml-1 opacity-70">{counts[t]}</span>
                            ) : null}
                        </button>
                    ))}
                </div>
                <select
                    value={category}
                    onChange={(e) => {
                        setCategory(e.target.value as TicketCategory | '');
                        setPage(1);
                    }}
                    className={input}
                    aria-label={m.columns.category}
                >
                    <option value="">{m.allCategories}</option>
                    {TICKET_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                            {tm.category[c]}
                        </option>
                    ))}
                </select>
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        setQuery(q.trim());
                        setPage(1);
                    }}
                    className="flex gap-2"
                >
                    <input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder={m.searchPlaceholder}
                        className={`${input} w-72`}
                    />
                    <button type="submit" className={btn}>
                        {m.search}
                    </button>
                </form>
            </div>

            <div
                className={[
                    'overflow-x-auto rounded-xl border',
                    isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm',
                ].join(' ')}
            >
                {loading ? (
                    <div className={`py-12 text-center ${muted}`}>{m.loading}</div>
                ) : items.length === 0 ? (
                    <div className={`py-12 text-center ${muted}`}>{m.none}</div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr
                                className={
                                    isDark
                                        ? 'border-b border-slate-700 text-slate-400'
                                        : 'border-b border-slate-200 text-slate-500'
                                }
                            >
                                {[
                                    m.columns.number,
                                    m.columns.subject,
                                    m.columns.customer,
                                    m.columns.category,
                                    m.columns.status,
                                    m.columns.priority,
                                    m.columns.waiting,
                                    m.columns.credit,
                                    m.columns.updated,
                                ].map((h) => (
                                    <th key={h} className="px-3 py-2 text-left text-xs font-medium whitespace-nowrap">
                                        {h}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {items.map((t) => (
                                <tr
                                    key={t.id}
                                    className={isDark ? 'border-b border-slate-700/60' : 'border-b border-slate-100'}
                                    data-ticket={t.number}
                                >
                                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                                        <Link href={`/admin/tickets/${t.id}${qs}`} className={link}>
                                            {t.number}
                                        </Link>
                                    </td>
                                    <td className="px-3 py-2 max-w-[320px]">
                                        <Link href={`/admin/tickets/${t.id}${qs}`} className={`${link} block truncate`}>
                                            {t.subject}
                                        </Link>
                                        {t.model ? <span className={`block text-xs ${muted}`}>{t.model}</span> : null}
                                    </td>
                                    <td className="px-3 py-2 text-xs">
                                        <Link href={`/admin/customers/${t.customer.id}${qs}`} className={link}>
                                            {t.customer.email}
                                        </Link>
                                    </td>
                                    <td className="px-3 py-2 text-xs whitespace-nowrap">{tm.category[t.category]}</td>
                                    <td className="px-3 py-2 whitespace-nowrap">
                                        <span className={`rounded px-2 py-0.5 text-xs ${STATUS_PILL[t.status]}`}>
                                            {m.tabs[t.status]}
                                        </span>
                                    </td>
                                    <td className={`px-3 py-2 text-xs ${PRIORITY_PILL[t.priority]}`}>
                                        {m.priority[t.priority]}
                                    </td>
                                    <td className="px-3 py-2 text-xs tabular-nums whitespace-nowrap">
                                        {t.status === 'open'
                                            ? (() => {
                                                  const h = hoursSince(t.last_customer_msg_at ?? t.created_at);
                                                  const overdue =
                                                      !!sla &&
                                                      ((!t.first_reply_at &&
                                                          hoursSince(t.created_at) > sla.firstReplyHours) ||
                                                          hoursSince(t.created_at) > sla.resolveHours);
                                                  return (
                                                      <span
                                                          className={overdue ? 'font-semibold text-red-500' : ''}
                                                          data-overdue={overdue || undefined}
                                                      >
                                                          {m.waitingFor(h)}
                                                          {overdue ? ` · ${m.sla.overdue}` : ''}
                                                      </span>
                                                  );
                                              })()
                                            : '—'}
                                    </td>
                                    <td className="px-3 py-2 text-xs tabular-nums">
                                        {t.credit_cny != null ? `¥${t.credit_cny.toFixed(2)}` : '—'}
                                    </td>
                                    <td className={`px-3 py-2 text-xs whitespace-nowrap ${muted}`}>
                                        {fmtTime(t.updated_at, locale)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            <div className={`mt-3 flex items-center justify-between text-xs ${muted}`}>
                <span>{m.pageInfo(page, total)}</span>
                <div className="flex gap-2">
                    <button type="button" className={btn} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                        {m.prev}
                    </button>
                    <button
                        type="button"
                        className={btn}
                        disabled={page * 50 >= total}
                        onClick={() => setPage((p) => p + 1)}
                    >
                        {m.next}
                    </button>
                </div>
            </div>
        </PayPageLayout>
    );
}

export default function AdminTicketsPage() {
    return (
        <Suspense fallback={null}>
            <TicketsQueue />
        </Suspense>
    );
}

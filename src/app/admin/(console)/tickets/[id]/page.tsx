'use client';

/** /admin/tickets/[id] — 工单详情:线程 + 回复 | 客户上下文 + 处置 + 管理(PR2)。 */
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import type { TicketPriority, TicketResolution } from '@prisma/client';
import PayPageLayout from '@/components/PayPageLayout';
import { resolveLocale } from '@/lib/locale';
import { pickMessages } from '@/lib/i18n';
import { adminTicketsMessages } from '@/lib/i18n/messages/admin-tickets';
import { ticketsMessages } from '@/lib/i18n/messages/tickets';
import type { AdminTicketContext } from '@/lib/tickets/admin-service';
import { adminQuery, fmtTime, PRIORITY_PILL, STATUS_PILL } from '../shared';

interface TicketDto {
    id: string;
    number: string;
    category: 'billing' | 'api_error' | 'recharge' | 'account' | 'other';
    status: 'open' | 'waiting_customer' | 'resolved' | 'closed';
    priority: TicketPriority;
    subject: string;
    request_id: string | null;
    order_id: string | null;
    model: string | null;
    disputed_cny: number | null;
    resolution: TicketResolution | null;
    credit_cny: number | null;
    reopen_count: number;
    assignee: string | null;
    created_at: string;
    updated_at: string;
}
interface MessageDto {
    id: string;
    author_type: 'customer' | 'staff' | 'system';
    author_id: string | null;
    body: string;
    internal: boolean;
    attachments?: Array<{ key: string; name: string; url: string | null }>;
    created_at: string;
}
interface EventDto {
    id: string;
    type: string;
    actor: string;
    payload: Record<string, unknown> | null;
    created_at: string;
}
interface DetailDto {
    ticket: TicketDto;
    messages: MessageDto[];
    events: EventDto[];
    context: AdminTicketContext;
}

const RESOLUTIONS: TicketResolution[] = ['credited', 'refunded', 'explained', 'fixed', 'rejected', 'duplicate'];
const PRIORITIES: TicketPriority[] = ['low', 'normal', 'high'];

function TicketDetail() {
    const params = useParams<{ id: string }>();
    const id = params.id;
    const sp = useSearchParams();
    const locale = resolveLocale(sp.get('lang'));
    const isDark = (sp.get('theme') || 'light') === 'dark';
    const isEmbedded = (sp.get('ui_mode') || 'standalone') === 'embedded';
    const m = pickMessages(adminTicketsMessages, locale);
    const d = m.detail;
    const tm = pickMessages(ticketsMessages, locale);
    const qs = adminQuery(sp);

    const [data, setData] = useState<DetailDto | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);

    const [reply, setReply] = useState('');
    const [internal, setInternal] = useState(false);
    const [resolution, setResolution] = useState<TicketResolution>('explained');
    const [credit, setCredit] = useState('');
    const [note, setNote] = useState('');
    const [priority, setPriority] = useState<TicketPriority>('normal');
    const [assignee, setAssignee] = useState('');

    const errText = useCallback(
        (code: string, status: number) => {
            const map = d.errors as Record<string, string | ((n: number) => string)>;
            const v = map[code];
            return typeof v === 'string' ? v : d.errors.generic(status);
        },
        [d.errors],
    );

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch(`/api/admin/tickets/${id}`, { credentials: 'same-origin' });
            if (res.status === 401) return setError(m.sessionExpired);
            if (res.status === 404) return setError(d.notFound);
            if (!res.ok) throw new Error(String(res.status));
            const dto = (await res.json()) as DetailDto;
            setData(dto);
            setPriority(dto.ticket.priority);
            setAssignee(dto.ticket.assignee ?? '');
            if (dto.ticket.resolution) setResolution(dto.ticket.resolution);
        } catch {
            setError(m.loadFailed);
        } finally {
            setLoading(false);
        }
    }, [id, m.sessionExpired, m.loadFailed, d.notFound]);

    useEffect(() => {
        void load();
    }, [load]);

    async function call(path: string, method: string, body: unknown): Promise<Record<string, unknown> | null> {
        setBusy(true);
        setError('');
        setNotice('');
        try {
            const res = await fetch(`/api/admin/tickets/${id}${path}`, {
                method,
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
            if (!res.ok) {
                setError(errText(typeof json.error === 'string' ? json.error : '', res.status));
                return null;
            }
            return json;
        } catch {
            setError(d.errors.generic(0));
            return null;
        } finally {
            setBusy(false);
        }
    }

    const card = [
        'rounded-xl border p-4',
        isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm',
    ].join(' ');
    const btn = [
        'inline-flex items-center rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
        isDark
            ? 'border-slate-600 text-slate-200 hover:bg-slate-800'
            : 'border-slate-300 text-slate-700 hover:bg-slate-100',
    ].join(' ');
    const primary =
        'inline-flex items-center rounded-lg border border-emerald-500 bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50';
    const input = [
        'w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50',
        isDark ? 'border-slate-600 bg-slate-700 text-slate-100' : 'border-slate-300 bg-white text-slate-900',
    ].join(' ');
    const label = ['block text-xs font-medium mb-1', isDark ? 'text-slate-300' : 'text-slate-600'].join(' ');
    const muted = isDark ? 'text-slate-400' : 'text-gray-500';
    const link = isDark ? 'text-indigo-400 hover:underline' : 'text-indigo-600 hover:underline';
    const h3 = `mb-3 text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`;

    const t = data?.ticket;
    const ctx = data?.context;

    const thread = data
        ? [
              ...data.messages.map((x) => ({ kind: 'message' as const, at: x.created_at, item: x })),
              ...data.events.map((x) => ({ kind: 'event' as const, at: x.created_at, item: x })),
          ].sort((a, b) => a.at.localeCompare(b.at) || (a.kind === 'event' ? 1 : -1))
        : [];

    function eventLabel(e: EventDto): string {
        const p = e.payload ?? {};
        const str = (k: string) => (typeof p[k] === 'string' || typeof p[k] === 'number' ? String(p[k]) : '');
        switch (e.type) {
            case 'created':
                return d.events.created;
            case 'request_located':
                return `${d.events.request_located}: ${str('model')} ¥${Number(str('cost_cny') || 0).toFixed(4)}`;
            case 'status_changed':
                return d.events.status_changed(str('from'), str('to')) + (str('reason') ? ` (${str('reason')})` : '');
            case 'credited':
                return d.events.credited(Number(str('amount_cny') || 0).toFixed(2));
            case 'priority_changed':
                return d.events.priority_changed(str('to'));
            case 'assigned':
                return d.events.assigned(str('to'));
            default:
                return e.type;
        }
    }

    async function sendReply() {
        if (!reply.trim()) return;
        const r = await call('/messages', 'POST', { body: reply.trim(), internal });
        if (r) {
            setReply('');
            await load();
        }
    }

    async function submitResolve() {
        if (!t || !ctx) return;
        const amount = credit.trim() === '' ? 0 : Number(credit);
        if (amount > 0 && !window.confirm(d.resolve.confirm(amount.toFixed(2), ctx.customer.email))) return;
        const r = await call('/resolve', 'POST', {
            resolution,
            credit_cny: amount > 0 ? amount : undefined,
            note: note.trim() || undefined,
        });
        if (r) {
            const bal = typeof r.balance_after_cny === 'number' ? (r.balance_after_cny as number).toFixed(2) : null;
            setNotice(d.resolve.done(bal));
            setCredit('');
            setNote('');
            await load();
        }
    }

    async function patch(body: Record<string, unknown>) {
        const r = await call('', 'PATCH', body);
        if (r) await load();
    }

    return (
        <PayPageLayout
            isDark={isDark}
            isEmbedded={isEmbedded}
            maxWidth="full"
            title={t ? `${t.number} · ${t.subject}` : m.title}
            subtitle={m.subtitle}
            locale={locale}
        >
            <Link href={`/admin/tickets${qs}`} className={`mb-3 inline-block text-xs ${link}`}>
                {d.back}
            </Link>
            {error && (
                <div
                    className={`mb-4 rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/50 text-red-400' : 'border-red-200 bg-red-50 text-red-600'}`}
                >
                    {error}
                </div>
            )}
            {notice && (
                <div
                    className={`mb-4 rounded-lg border p-3 text-sm ${isDark ? 'border-emerald-800 bg-emerald-950/50 text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}
                >
                    {notice}
                </div>
            )}
            {loading || !t || !ctx ? (
                <div className={`py-12 text-center ${muted}`}>{loading ? m.loading : ''}</div>
            ) : (
                <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                    {/* ── 左:线程 + 回复 ── */}
                    <div className="flex flex-col gap-4">
                        <div className={card}>
                            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                                <span className={`rounded px-2 py-0.5 ${STATUS_PILL[t.status]}`}>
                                    {m.tabs[t.status]}
                                </span>
                                <span className={PRIORITY_PILL[t.priority]}>{m.priority[t.priority]}</span>
                                <span className={muted}>{tm.category[t.category]}</span>
                                {t.resolution ? <span className={muted}>· {tm.resolution[t.resolution]}</span> : null}
                                {t.reopen_count > 0 ? (
                                    <span className="text-amber-500">· {d.reopened(t.reopen_count)}</span>
                                ) : null}
                                <span className={`ml-auto ${muted}`}>{fmtTime(t.created_at, locale)}</span>
                            </div>
                            <dl className={`grid grid-cols-2 gap-x-4 gap-y-1 text-xs ${muted}`}>
                                {t.request_id ? (
                                    <>
                                        <dt>{d.requestId}</dt>
                                        <dd className="font-mono break-all">{t.request_id}</dd>
                                    </>
                                ) : null}
                                {t.model ? (
                                    <>
                                        <dt>{d.model}</dt>
                                        <dd>{t.model}</dd>
                                    </>
                                ) : null}
                                {t.disputed_cny != null ? (
                                    <>
                                        <dt>{d.disputed}</dt>
                                        <dd>¥{t.disputed_cny.toFixed(2)}</dd>
                                    </>
                                ) : null}
                                {t.order_id ? (
                                    <>
                                        <dt>{d.order}</dt>
                                        <dd className="font-mono">{t.order_id}</dd>
                                    </>
                                ) : null}
                            </dl>
                        </div>

                        <section className={card} aria-label={d.thread} data-testid="admin-thread">
                            <h3 className={h3}>{d.thread}</h3>
                            <div className="flex flex-col gap-2">
                                {thread.map((x) =>
                                    x.kind === 'event' ? (
                                        <p
                                            key={x.item.id}
                                            className={`m-0 text-center text-xs ${muted}`}
                                            data-event={x.item.type}
                                        >
                                            {eventLabel(x.item)} · {fmtTime(x.at, locale)}
                                        </p>
                                    ) : (
                                        <article
                                            key={x.item.id}
                                            data-author={x.item.author_type}
                                            data-internal={x.item.internal || undefined}
                                            className={[
                                                'rounded-lg border px-3 py-2 text-sm',
                                                x.item.internal
                                                    ? 'border-amber-400/50 bg-amber-500/10'
                                                    : x.item.author_type === 'customer'
                                                      ? isDark
                                                          ? 'border-slate-600 bg-slate-900/40'
                                                          : 'border-slate-200 bg-slate-50'
                                                      : 'border-emerald-500/40 bg-emerald-500/5',
                                            ].join(' ')}
                                        >
                                            <header className={`mb-1 flex justify-between gap-2 text-xs ${muted}`}>
                                                <span>
                                                    {d.author[x.item.author_type]}
                                                    {x.item.author_id && x.item.author_type === 'staff'
                                                        ? ` · ${x.item.author_id}`
                                                        : ''}
                                                    {x.item.internal ? ` · ${d.internal}` : ''}
                                                </span>
                                                <time>{fmtTime(x.at, locale)}</time>
                                            </header>
                                            <p className="m-0 whitespace-pre-wrap break-words">{x.item.body}</p>
                                            {x.item.attachments && x.item.attachments.length > 0 ? (
                                                <div
                                                    className="mt-2 flex flex-wrap gap-2"
                                                    data-testid="admin-attachments"
                                                >
                                                    {x.item.attachments.map((a) =>
                                                        a.url ? (
                                                            <a
                                                                key={a.key}
                                                                href={a.url}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                title={a.name}
                                                            >
                                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                                <img
                                                                    src={a.url}
                                                                    alt={a.name}
                                                                    className="h-16 w-16 rounded border border-slate-300 object-cover"
                                                                />
                                                            </a>
                                                        ) : (
                                                            <span key={a.key} className={`text-xs ${muted}`}>
                                                                {a.name}
                                                            </span>
                                                        ),
                                                    )}
                                                </div>
                                            ) : null}
                                        </article>
                                    ),
                                )}
                            </div>
                        </section>

                        <section className={card} data-testid="admin-reply">
                            <h3 className={h3}>{d.reply.heading}</h3>
                            {t.status === 'closed' ? (
                                <p className={`m-0 mb-2 text-xs ${muted}`}>{d.reply.closedHint}</p>
                            ) : null}
                            <textarea
                                value={reply}
                                onChange={(e) => setReply(e.target.value)}
                                placeholder={d.reply.placeholder}
                                className={`${input} min-h-[110px]`}
                                maxLength={5000}
                            />
                            <div className="mt-2 flex flex-wrap items-center gap-3">
                                <label className={`flex items-center gap-1.5 text-xs ${muted}`}>
                                    <input
                                        type="checkbox"
                                        checked={internal || t.status === 'closed'}
                                        disabled={t.status === 'closed'}
                                        onChange={(e) => setInternal(e.target.checked)}
                                    />
                                    {d.reply.internalLabel}
                                </label>
                                <button
                                    type="button"
                                    className={primary}
                                    disabled={busy || !reply.trim()}
                                    onClick={() => void sendReply()}
                                >
                                    {busy
                                        ? d.reply.sending
                                        : internal || t.status === 'closed'
                                          ? d.reply.sendInternal
                                          : d.reply.send}
                                </button>
                            </div>
                        </section>
                    </div>

                    {/* ── 右:客户 / 上下文 / 处置 / 管理 ── */}
                    <div className="flex flex-col gap-4">
                        <section className={card} data-testid="admin-customer">
                            <h3 className={h3}>{d.customerCard}</h3>
                            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                                <dt className={muted}>{d.email}</dt>
                                <dd>
                                    <Link href={`/admin/customers/${ctx.customer.id}${qs}`} className={link}>
                                        {ctx.customer.email}
                                    </Link>
                                    {ctx.customer.nickname ? (
                                        <span className={` ${muted}`}> · {ctx.customer.nickname}</span>
                                    ) : null}
                                </dd>
                                <dt className={muted}>{d.username}</dt>
                                <dd className="font-mono">
                                    {ctx.customer.username ?? '—'}{' '}
                                    {ctx.customer.newapi_user_id != null ? `(#${ctx.customer.newapi_user_id})` : ''}
                                </dd>
                                <dt className={muted}>{d.billingMode}</dt>
                                <dd>{ctx.customer.billing_mode}</dd>
                                <dt className={muted}>{d.balance}</dt>
                                <dd className="tabular-nums">
                                    {ctx.balance ? (
                                        <>
                                            ¥{ctx.balance.remain_cny.toFixed(2)}
                                            {ctx.balance.source === 'fallback' ? (
                                                <span className={`ml-1 ${muted}`}>{d.stale}</span>
                                            ) : null}
                                        </>
                                    ) : (
                                        <span className={muted}>{d.balanceUnavailable}</span>
                                    )}
                                </dd>
                                {ctx.balance ? (
                                    <>
                                        <dt className={muted}>{d.used}</dt>
                                        <dd className="tabular-nums">¥{ctx.balance.used_cny.toFixed(2)}</dd>
                                    </>
                                ) : null}
                                <dt className={muted}>{d.ticketCount}</dt>
                                <dd>{ctx.customer.ticket_count}</dd>
                            </dl>
                            <Link
                                href={`/admin/customers/${ctx.customer.id}${qs}`}
                                className={`mt-2 inline-block text-xs ${link}`}
                            >
                                {d.customerPage}
                            </Link>
                        </section>

                        <section className={card} data-testid="admin-resolve">
                            <h3 className={h3}>{d.resolve.heading}</h3>
                            <label className={label}>{d.resolve.resolution}</label>
                            <select
                                value={resolution}
                                onChange={(e) => setResolution(e.target.value as TicketResolution)}
                                className={input}
                            >
                                {RESOLUTIONS.map((r) => (
                                    <option key={r} value={r}>
                                        {tm.resolution[r]}
                                    </option>
                                ))}
                            </select>
                            <label className={`${label} mt-3`}>{d.resolve.credit}</label>
                            <input
                                type="number"
                                min={0}
                                step="0.01"
                                value={credit}
                                onChange={(e) => setCredit(e.target.value)}
                                className={input}
                                inputMode="decimal"
                            />
                            <p className={`m-0 mt-1 text-xs ${muted}`}>{d.resolve.creditHint}</p>
                            <label className={`${label} mt-3`}>{d.resolve.note}</label>
                            <textarea
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                className={`${input} min-h-[80px]`}
                                maxLength={5000}
                            />
                            <button
                                type="button"
                                className={`${primary} mt-3`}
                                disabled={
                                    busy || t.status === 'closed' || (credit.trim() !== '' && !(Number(credit) >= 0))
                                }
                                onClick={() => void submitResolve()}
                            >
                                {busy ? d.resolve.submitting : d.resolve.submit}
                            </button>
                        </section>

                        <section className={card} data-testid="admin-manage">
                            <h3 className={h3}>{d.manage.heading}</h3>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className={label}>{d.manage.priority}</label>
                                    <select
                                        value={priority}
                                        onChange={(e) => setPriority(e.target.value as TicketPriority)}
                                        className={input}
                                    >
                                        {PRIORITIES.map((p) => (
                                            <option key={p} value={p}>
                                                {m.priority[p]}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className={label}>{d.manage.assignee}</label>
                                    <input
                                        value={assignee}
                                        onChange={(e) => setAssignee(e.target.value)}
                                        placeholder={d.manage.assigneePlaceholder}
                                        className={input}
                                        maxLength={80}
                                    />
                                </div>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    className={btn}
                                    disabled={busy}
                                    onClick={() => void patch({ priority, assignee: assignee.trim() || null })}
                                >
                                    {d.manage.save}
                                </button>
                                {t.status !== 'closed' ? (
                                    <button
                                        type="button"
                                        className={btn}
                                        disabled={busy}
                                        title={!t.resolution ? d.manage.closeNeedsResolution : undefined}
                                        onClick={() => {
                                            if (!t.resolution && !resolution)
                                                return setError(d.manage.closeNeedsResolution);
                                            if (!window.confirm(d.manage.closeConfirm)) return;
                                            void patch({ status: 'closed', resolution: t.resolution ?? resolution });
                                        }}
                                    >
                                        {d.manage.close}
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className={btn}
                                        disabled={busy}
                                        onClick={() => void patch({ status: 'open' })}
                                    >
                                        {d.manage.reopen}
                                    </button>
                                )}
                            </div>
                        </section>

                        <section className={card} data-testid="admin-logs">
                            <h3 className={h3}>{d.logs}</h3>
                            {ctx.logs_error ? (
                                <p className={`m-0 text-xs ${muted}`}>
                                    {d.logsError} {ctx.logs_error}
                                </p>
                            ) : ctx.logs.length === 0 ? (
                                <p className={`m-0 text-xs ${muted}`}>{d.noLogs}</p>
                            ) : (
                                <div className="max-h-80 overflow-auto">
                                    <table className="w-full text-xs">
                                        <thead>
                                            <tr className={muted}>
                                                <th className="py-1 text-left font-medium">{d.logCols.time}</th>
                                                <th className="py-1 text-left font-medium">{d.logCols.model}</th>
                                                <th className="py-1 text-right font-medium">{d.logCols.cost}</th>
                                                <th className="py-1 text-left font-medium">{d.logCols.request}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {ctx.logs.map((l, i) => (
                                                <tr
                                                    key={`${l.requestId}-${i}`}
                                                    data-matched={l.matched || undefined}
                                                    className={l.matched ? 'bg-amber-500/15 font-semibold' : ''}
                                                >
                                                    <td className="py-1 whitespace-nowrap tabular-nums">
                                                        {fmtTime(l.createdAt, locale)}
                                                    </td>
                                                    <td className="py-1">
                                                        {l.model}
                                                        {l.failed ? (
                                                            <span className="ml-1 text-red-500">{d.failedCall}</span>
                                                        ) : null}
                                                    </td>
                                                    <td className="py-1 text-right tabular-nums">
                                                        ¥{l.costCny.toFixed(4)}
                                                    </td>
                                                    <td className="py-1 font-mono" title={l.requestId}>
                                                        {l.requestId.slice(-10)}
                                                        {l.matched ? (
                                                            <span className="ml-1 text-amber-600">{d.matched}</span>
                                                        ) : null}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </section>

                        <section className={card} data-testid="admin-recharges">
                            <h3 className={h3}>{d.recharges}</h3>
                            {ctx.recharges.length === 0 ? (
                                <p className={`m-0 text-xs ${muted}`}>{d.noRecharges}</p>
                            ) : (
                                <ul className="m-0 list-none p-0 text-xs">
                                    {ctx.recharges.map((r) => (
                                        <li key={r.id} className="flex justify-between gap-2 py-1">
                                            <span className={muted}>{fmtTime(r.created_at, locale)}</span>
                                            <span>{r.source}</span>
                                            <span className="tabular-nums">¥{r.amount.toFixed(2)}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                    </div>
                </div>
            )}
        </PayPageLayout>
    );
}

export default function AdminTicketDetailPage() {
    return (
        <Suspense fallback={null}>
            <TicketDetail />
        </Suspense>
    );
}

/** /support/[id] — 工单详情:元信息 + 消息 / 事件线程 + 客户动作(回复 / 确认 / 重开)。 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/Card';
import { getLocale } from '@/lib/i18n/server';
import { intlLocale, pickMessages } from '@/lib/i18n';
import { ticketsMessages } from '@/lib/i18n/messages/tickets';
import { getTicketForUser } from '@/lib/tickets/service';
import { formatTicketNumber } from '@/lib/tickets/status';
import { UuidSchema } from '@/lib/tickets/http';
import { TicketStatusBadge } from '../status-badge';
import { formatDateTime, getSessionUser } from '../session';
import { TicketActions } from './ticket-actions';
import { buildThread } from './thread';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
    const [{ id }, user, locale] = await Promise.all([params, getSessionUser(), getLocale()]);
    const m = pickMessages(ticketsMessages, locale);
    // 标题用对客编号 T-000123;查不到(非本人 / 非 uuid)退回短 id,页面本体会 404。
    const ticket = user && UuidSchema.safeParse(id).success ? await getTicketForUser(id, user.id) : null;
    return { title: m.meta.detailTitle(ticket ? formatTicketNumber(ticket.number) : id.slice(0, 8)) };
}

export default async function TicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const [{ id }, user, locale] = await Promise.all([params, getSessionUser(), getLocale()]);
    if (!user) return null;
    if (!UuidSchema.safeParse(id).success) notFound();
    const ticket = await getTicketForUser(id, user.id);
    if (!ticket) notFound();
    const m = pickMessages(ticketsMessages, locale);
    const intl = intlLocale(locale);
    const number = formatTicketNumber(ticket.number);
    const thread = buildThread(ticket, m, intl);

    const metaRows: Array<[string, string | null]> = [
        [m.detail.meta.category, m.category[ticket.category]],
        [m.detail.meta.created, formatDateTime(ticket.created_at, intl)],
        [m.detail.meta.requestId, ticket.request_id],
        [m.detail.meta.model, ticket.model],
        [m.detail.meta.order, ticket.order_id],
        [m.detail.meta.disputed, ticket.disputed_cny ? `¥${Number(ticket.disputed_cny).toFixed(2)}` : null],
        [m.detail.meta.resolution, ticket.resolution ? m.resolution[ticket.resolution] : null],
        [m.detail.meta.credit, ticket.credit_cny ? `¥${Number(ticket.credit_cny).toFixed(2)}` : null],
    ];

    return (
        <div className="max-w-4xl">
            <Link
                href="/support"
                className="mb-3 inline-block text-xs text-muted-ink no-underline hover:text-brand-accent"
            >
                {m.detail.back}
            </Link>
            <div className="mb-4 flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm text-muted-ink">{number}</span>
                <h1 className="m-0 text-xl font-semibold text-navy">{ticket.subject}</h1>
                <TicketStatusBadge status={ticket.status} label={m.status[ticket.status]} />
            </div>

            <Card className="mb-4">
                <CardContent>
                    <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                        {metaRows
                            .filter(([, v]) => v)
                            .map(([k, v]) => (
                                <div key={k} className="flex gap-2">
                                    <dt className="m-0 w-24 shrink-0 text-muted-ink">{k}</dt>
                                    <dd className="m-0 break-all font-medium text-ink">{v}</dd>
                                </div>
                            ))}
                    </dl>
                </CardContent>
            </Card>

            <section aria-label="thread" className="mb-4 flex flex-col gap-3" data-testid="ticket-thread">
                {thread.map((item) =>
                    item.kind === 'event' ? (
                        <p key={item.id} className="m-0 text-center text-xs text-minor-ink" data-event={item.type}>
                            {item.text} · {item.time}
                        </p>
                    ) : (
                        <article
                            key={item.id}
                            data-author={item.author}
                            className={[
                                'rounded-lg border px-4 py-3 text-sm',
                                item.author === 'customer'
                                    ? 'border-brand-border bg-surface'
                                    : 'border-brand-accent/40 bg-paper-muted',
                            ].join(' ')}
                        >
                            <header className="mb-1.5 flex items-center justify-between gap-3 text-xs text-muted-ink">
                                <span className="font-medium text-navy">{m.detail.author[item.author]}</span>
                                <time>{item.time}</time>
                            </header>
                            <p className="m-0 whitespace-pre-wrap break-words text-ink">{item.body}</p>
                        </article>
                    ),
                )}
            </section>

            <TicketActions ticketId={ticket.id} status={ticket.status} />
        </div>
    );
}

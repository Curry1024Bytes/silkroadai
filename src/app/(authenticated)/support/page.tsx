/**
 * /support — 客诉工单列表(客户侧,2026-11-07 PR1)。
 * Auth 由 (authenticated)/layout 守门;本页按 ?status=active|resolved|all 过滤。
 */
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { getLocale } from '@/lib/i18n/server';
import { intlLocale, pickMessages } from '@/lib/i18n';
import { ticketsMessages } from '@/lib/i18n/messages/tickets';
import { listTicketsForUser, type TicketListFilter } from '@/lib/tickets/service';
import { TicketStatusBadge } from './status-badge';
import { formatDateTime, getSessionUser } from './session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
    return { title: pickMessages(ticketsMessages, await getLocale()).meta.listTitle };
}

const FILTERS: TicketListFilter[] = ['active', 'resolved', 'all'];

function parseFilter(v: string | string[] | undefined): TicketListFilter {
    return typeof v === 'string' && (FILTERS as string[]).includes(v) ? (v as TicketListFilter) : 'active';
}

export default async function SupportListPage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const [user, locale, params] = await Promise.all([
        getSessionUser(),
        getLocale(),
        searchParams ?? Promise.resolve<Record<string, string | string[] | undefined>>({}),
    ]);
    if (!user) return null;
    const m = pickMessages(ticketsMessages, locale);
    const filter = parseFilter(params.status);
    const tickets = await listTicketsForUser(user.id, filter);
    const intl = intlLocale(locale);

    return (
        <div className="max-w-5xl">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="m-0 text-2xl font-semibold text-navy">{m.list.heading}</h1>
                    <p className="m-0 mt-2 max-w-2xl text-sm text-muted-ink">{m.list.intro}</p>
                </div>
                <Button href="/support/new" variant="primary" size="md">
                    {m.list.newButton}
                </Button>
            </div>

            <nav className="mb-4 flex gap-1 border-b border-brand-border" aria-label="filter">
                {FILTERS.map((f) => (
                    <Link
                        key={f}
                        href={f === 'active' ? '/support' : `/support?status=${f}`}
                        aria-current={f === filter ? 'page' : undefined}
                        className={[
                            'px-3 py-2 text-sm no-underline border-b-2 -mb-px transition-colors duration-150 ease-brand',
                            f === filter
                                ? 'border-brand-accent text-navy font-semibold'
                                : 'border-transparent text-muted-ink hover:text-navy',
                        ].join(' ')}
                    >
                        {m.list.tabs[f]}
                    </Link>
                ))}
            </nav>

            <Card>
                {tickets.length === 0 ? (
                    <EmptyState
                        title={m.list.empty.title}
                        body={m.list.empty.body}
                        action={
                            <Button href="/support/new" variant="secondary" size="sm">
                                {m.list.empty.action}
                            </Button>
                        }
                    />
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="text-left text-xs uppercase tracking-wide text-minor-ink">
                                    <th className="px-4 py-3 font-medium">{m.list.columns.number}</th>
                                    <th className="px-4 py-3 font-medium">{m.list.columns.subject}</th>
                                    <th className="px-4 py-3 font-medium">{m.list.columns.category}</th>
                                    <th className="px-4 py-3 font-medium">{m.list.columns.status}</th>
                                    <th className="px-4 py-3 font-medium">{m.list.columns.updated}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {tickets.map((t) => (
                                    <tr key={t.id} className="border-t border-brand-border hover:bg-paper-muted/50">
                                        <td className="px-4 py-3 font-mono text-xs text-muted-ink">
                                            <Link
                                                href={`/support/${t.id}`}
                                                className="text-navy no-underline hover:text-brand-accent"
                                            >
                                                {t.number}
                                            </Link>
                                        </td>
                                        <td className="px-4 py-3">
                                            <Link
                                                href={`/support/${t.id}`}
                                                className="text-ink no-underline hover:text-brand-accent"
                                            >
                                                {t.subject}
                                            </Link>
                                        </td>
                                        <td className="px-4 py-3 text-muted-ink">{m.category[t.category]}</td>
                                        <td className="px-4 py-3">
                                            <TicketStatusBadge status={t.status} label={m.status[t.status]} />
                                        </td>
                                        <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-ink tabular-nums">
                                            {formatDateTime(t.updatedAt, intl)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>
        </div>
    );
}

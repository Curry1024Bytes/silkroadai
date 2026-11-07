/** /support/new — 提交工单(server shell + client 表单)。最近 10 笔订单给「充值与余额」分类选。 */
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getLocale } from '@/lib/i18n/server';
import { intlLocale, pickMessages } from '@/lib/i18n';
import { ticketsMessages } from '@/lib/i18n/messages/tickets';
import { NewTicketForm, type OrderOption } from './new-ticket-form';
import { formatDateTime, getSessionUser } from '../session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
    return { title: pickMessages(ticketsMessages, await getLocale()).meta.newTitle };
}

export default async function NewTicketPage() {
    const [user, locale] = await Promise.all([getSessionUser(), getLocale()]);
    if (!user) return null;
    const m = pickMessages(ticketsMessages, locale);

    let orders: OrderOption[] = [];
    try {
        const rows = await prisma.order.findMany({
            where: { user_id: user.id },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: { id: true, amount: true, status: true, createdAt: true },
        });
        orders = rows.map((o) => ({
            id: o.id,
            label: m.form.orderOption(
                Number(o.amount).toFixed(2),
                formatDateTime(o.createdAt, intlLocale(locale)),
                o.status,
            ),
        }));
    } catch (e) {
        console.warn('[support/new] order list failed:', e);
    }

    return (
        <div className="max-w-3xl">
            <Link
                href="/support"
                className="mb-3 inline-block text-xs text-muted-ink no-underline hover:text-brand-accent"
            >
                {m.detail.back}
            </Link>
            <h1 className="m-0 mb-4 text-2xl font-semibold text-navy">{m.form.heading}</h1>
            <NewTicketForm orders={orders} />
        </div>
    );
}

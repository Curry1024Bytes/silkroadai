/** GET /api/portal/tickets/[id] — 工单详情(消息 + 事件;内部备注已过滤)。不是自己的一律 404。 */
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getTicketForUser, serializeEvent, serializeMessage, serializeTicket } from '@/lib/tickets/service';
import { UuidSchema } from '@/lib/tickets/http';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(req);
    if (!user) return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
    const { id } = await ctx.params;
    if (!UuidSchema.safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const ticket = await getTicketForUser(id, user.id);
    if (!ticket) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({
        ticket: serializeTicket(ticket),
        messages: ticket.messages.map(serializeMessage),
        events: ticket.events.map(serializeEvent),
    });
}

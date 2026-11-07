/** POST /api/portal/tickets/[id]/confirm — 客户确认已解决(resolved → closed)。 */
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { confirmResolved, serializeTicket } from '@/lib/tickets/service';
import { ticketErrorResponse, UuidSchema } from '@/lib/tickets/http';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(req);
    if (!user) return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
    const { id } = await ctx.params;
    if (!UuidSchema.safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    try {
        const ticket = await confirmResolved(id, user);
        return NextResponse.json({ ticket: serializeTicket(ticket) });
    } catch (e) {
        return ticketErrorResponse(e) ?? NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
}

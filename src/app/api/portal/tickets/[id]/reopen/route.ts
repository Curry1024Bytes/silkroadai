/** POST /api/portal/tickets/[id]/reopen { body } — 客户「仍未解决」(resolved → open,最多 3 次)。 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth/session';
import { reopenTicket, serializeTicket } from '@/lib/tickets/service';
import { readJson, ticketErrorResponse, UuidSchema } from '@/lib/tickets/http';

export const runtime = 'nodejs';

const Schema = z.object({ body: z.string().trim().min(1).max(5000) });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(req);
    if (!user) return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
    const { id } = await ctx.params;
    if (!UuidSchema.safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    try {
        const ticket = await reopenTicket(id, user, parsed.data.body);
        return NextResponse.json({ ticket: serializeTicket(ticket) });
    } catch (e) {
        return ticketErrorResponse(e) ?? NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
}

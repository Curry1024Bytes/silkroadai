/**
 * /api/admin/tickets/[id]
 *   GET   → 工单 + 全部消息(含内部备注)+ 事件 + 客户上下文(余额 / 充值 / 最近调用)
 *   PATCH { status?: 'closed'|'open', priority?, assignee?, resolution? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { getTicketAdmin, getTicketContext, updateTicketAdmin } from '@/lib/tickets/admin-service';
import { adminTicketErrorResponse } from '@/lib/tickets/admin-http';
import { readJson, UuidSchema } from '@/lib/tickets/http';
import { serializeEvent, serializeTicket } from '@/lib/tickets/service';

export const runtime = 'nodejs';

const PatchSchema = z.object({
    status: z.enum(['closed', 'open']).optional(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
    assignee: z.string().trim().max(80).nullable().optional(),
    resolution: z.enum(['credited', 'refunded', 'explained', 'fixed', 'rejected', 'duplicate']).optional(),
});

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);
    const { id } = await ctx.params;
    if (!UuidSchema.safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    try {
        const ticket = await getTicketAdmin(admin, id);
        const context = await getTicketContext(ticket);
        return NextResponse.json({
            ticket: {
                ...serializeTicket(ticket),
                assignee: ticket.assignee,
                first_reply_at: ticket.first_reply_at?.toISOString() ?? null,
            },
            messages: ticket.messages.map((m) => ({
                id: m.id,
                author_type: m.author_type,
                author_id: m.author_id,
                body: m.body,
                internal: m.internal,
                created_at: m.created_at.toISOString(),
            })),
            events: ticket.events.map((e) => ({ ...serializeEvent(e), actor: e.actor })),
            context,
        });
    } catch (e) {
        return adminTicketErrorResponse(e) ?? NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);
    const { id } = await ctx.params;
    if (!UuidSchema.safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const parsed = PatchSchema.safeParse(await readJson(request));
    if (!parsed.success)
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    try {
        const ticket = await updateTicketAdmin(admin, id, parsed.data);
        return NextResponse.json({ ticket: serializeTicket(ticket) });
    } catch (e) {
        return adminTicketErrorResponse(e) ?? NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
}

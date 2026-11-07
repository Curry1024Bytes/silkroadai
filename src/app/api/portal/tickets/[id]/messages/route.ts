/** POST /api/portal/tickets/[id]/messages { body } — 客户追加留言(waiting_customer → open)。 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth/session';
import { addCustomerMessage, serializeMessage } from '@/lib/tickets/service';
import { readJson, ticketErrorResponse, UuidSchema } from '@/lib/tickets/http';
import { AttachmentListSchema } from '@/lib/tickets/attachments';

export const runtime = 'nodejs';

const Schema = z.object({ body: z.string().trim().min(1).max(5000), attachments: AttachmentListSchema });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(req);
    if (!user) return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
    const { id } = await ctx.params;
    if (!UuidSchema.safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    try {
        const message = await addCustomerMessage(id, user, parsed.data.body, parsed.data.attachments);
        return NextResponse.json({ message: serializeMessage(message) }, { status: 201 });
    } catch (e) {
        return ticketErrorResponse(e) ?? NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
}

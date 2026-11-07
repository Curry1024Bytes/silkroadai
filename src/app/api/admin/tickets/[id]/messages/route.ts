/** POST /api/admin/tickets/[id]/messages { body, internal? } — 客服回复(对客可见,发邮件)或内部备注。 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { staffReply } from '@/lib/tickets/admin-service';
import { adminTicketErrorResponse } from '@/lib/tickets/admin-http';
import { readJson, UuidSchema } from '@/lib/tickets/http';

export const runtime = 'nodejs';

const Schema = z.object({ body: z.string().trim().min(1).max(5000), internal: z.boolean().default(false) });

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);
    const { id } = await ctx.params;
    if (!UuidSchema.safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const parsed = Schema.safeParse(await readJson(request));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    try {
        const message = await staffReply(admin, id, parsed.data.body, parsed.data.internal);
        return NextResponse.json(
            {
                message: {
                    id: message.id,
                    author_type: message.author_type,
                    body: message.body,
                    internal: message.internal,
                    created_at: message.created_at.toISOString(),
                },
            },
            { status: 201 },
        );
    } catch (e) {
        return adminTicketErrorResponse(e) ?? NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
}

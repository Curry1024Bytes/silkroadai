/** POST /api/admin/tickets/[id]/resolve { resolution, credit_cny?, note? } — 处置(可选补额 add_quota)→ resolved + 邮件。 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { resolveTicketAdmin } from '@/lib/tickets/admin-service';
import { adminTicketErrorResponse } from '@/lib/tickets/admin-http';
import { readJson, UuidSchema } from '@/lib/tickets/http';
import { serializeTicket } from '@/lib/tickets/service';

export const runtime = 'nodejs';

const Schema = z.object({
    resolution: z.enum(['credited', 'refunded', 'explained', 'fixed', 'rejected', 'duplicate']),
    // 单次补额上限 ¥10,000(防 fat-finger;更大走客户详情页「余额调整」)。
    credit_cny: z.number().min(0).max(10_000).optional(),
    note: z.string().trim().max(5000).optional(),
});

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);
    const { id } = await ctx.params;
    if (!UuidSchema.safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const parsed = Schema.safeParse(await readJson(request));
    if (!parsed.success)
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    const d = parsed.data;
    try {
        const r = await resolveTicketAdmin(admin, id, {
            resolution: d.resolution,
            creditCny: d.credit_cny,
            note: d.note || undefined,
        });
        return NextResponse.json({ ticket: serializeTicket(r.ticket), balance_after_cny: r.balance_after_cny });
    } catch (e) {
        return adminTicketErrorResponse(e) ?? NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
}

/**
 * GET /api/admin/tickets?status=open|waiting_customer|resolved|closed|all&category=&q=&page=
 * 管理员工单队列。gate = admin(partner admin 走 tenantScope 只看本租户)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { listTicketsAdmin } from '@/lib/tickets/admin-service';
import { TICKET_CATEGORIES, TICKET_STATUSES } from '@/lib/tickets/status';

export const runtime = 'nodejs';

const QuerySchema = z.object({
    status: z.enum([...TICKET_STATUSES, 'all']).default('open'),
    category: z.enum(TICKET_CATEGORIES).optional(),
    q: z.string().trim().max(120).optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
});

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);
    const parsed = QuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    const q = parsed.data;
    const result = await listTicketsAdmin(admin, {
        status: q.status,
        category: q.category,
        q: q.q || undefined,
        page: q.page,
    });
    return NextResponse.json({ ...result, page: q.page });
}

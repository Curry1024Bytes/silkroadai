/**
 * /api/portal/tickets(客诉工单 PR1)
 *   GET  ?status=active|resolved|all  → 当前客户的工单列表
 *   POST { category, subject, body, request_id?, order_id?, disputed_cny? } → 201 新工单
 *
 * cookie 会话鉴权;名额 / 频率限制在 service 内(429)。错误体 `{ error: <code> }`,
 * 文案由客户端按 code 映射(i18n)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth/session';
import { getLocale } from '@/lib/i18n/server';
import { createTicket, listTicketsForUser, serializeTicket, type TicketListFilter } from '@/lib/tickets/service';
import { REQUEST_ID_PATTERN, TICKET_CATEGORIES } from '@/lib/tickets/status';
import { appUrl, readJson, ticketErrorResponse } from '@/lib/tickets/http';

export const runtime = 'nodejs';

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const CreateTicketSchema = z.object({
    category: z.enum(TICKET_CATEGORIES),
    subject: z.string().trim().min(2).max(120),
    body: z.string().trim().min(10).max(5000),
    request_id: z.preprocess(blankToUndefined, z.string().trim().regex(REQUEST_ID_PATTERN).optional()),
    order_id: z.preprocess(blankToUndefined, z.string().trim().max(40).optional()),
    disputed_cny: z.preprocess(
        (v) => (v === '' || v === null ? undefined : v),
        z.coerce.number().min(0).max(100000).optional(),
    ),
});

const ListSchema = z.object({ status: z.enum(['active', 'resolved', 'all']).default('active') });

export async function GET(req: NextRequest) {
    const user = await getCurrentUser(req);
    if (!user) return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
    const parsed = ListSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    const filter: TicketListFilter = parsed.success ? parsed.data.status : 'active';
    const tickets = await listTicketsForUser(user.id, filter);
    return NextResponse.json({
        tickets: tickets.map((t) => ({
            ...t,
            createdAt: t.createdAt.toISOString(),
            updatedAt: t.updatedAt.toISOString(),
        })),
    });
}

export async function POST(req: NextRequest) {
    const user = await getCurrentUser(req);
    if (!user) return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
    const body = await readJson(req);
    if (body === undefined) return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    const parsed = CreateTicketSchema.safeParse(body);
    if (!parsed.success) {
        const requestIdBad = parsed.error.issues.some((i) => i.path[0] === 'request_id');
        return NextResponse.json(
            { error: requestIdBad ? 'invalid_request_id' : 'invalid_input', details: parsed.error.flatten() },
            { status: 400 },
        );
    }
    const d = parsed.data;
    try {
        const ticket = await createTicket(
            user,
            {
                category: d.category,
                subject: d.subject,
                body: d.body,
                requestId: d.request_id,
                orderId: d.order_id,
                disputedCny: d.disputed_cny,
            },
            { locale: await getLocale(), appUrl: appUrl() },
        );
        return NextResponse.json({ ticket: serializeTicket(ticket) }, { status: 201 });
    } catch (e) {
        const mapped = ticketErrorResponse(e);
        if (mapped) return mapped;
        console.error('[portal/tickets] create failed:', e);
        return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
}

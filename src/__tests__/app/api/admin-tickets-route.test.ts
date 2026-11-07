/** /api/admin/tickets* 路由层:admin gate / zod / 错误码映射。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
const svc = vi.hoisted(() => ({
    list: vi.fn(),
    get: vi.fn(),
    context: vi.fn(),
    reply: vi.fn(),
    resolve: vi.fn(),
    update: vi.fn(),
}));
vi.mock('@/lib/tickets/admin-service', async () => {
    const actual = await vi.importActual<typeof import('@/lib/tickets/admin-service')>('@/lib/tickets/admin-service');
    return {
        ...actual,
        listTicketsAdmin: (...a: unknown[]) => svc.list(...a),
        getTicketAdmin: (...a: unknown[]) => svc.get(...a),
        getTicketContext: (...a: unknown[]) => svc.context(...a),
        staffReply: (...a: unknown[]) => svc.reply(...a),
        resolveTicketAdmin: (...a: unknown[]) => svc.resolve(...a),
        updateTicketAdmin: (...a: unknown[]) => svc.update(...a),
    };
});

import { AdminTicketError } from '@/lib/tickets/admin-service';
import { TicketError } from '@/lib/tickets/service';
import { GET } from '@/app/api/admin/tickets/route';
import { GET as GET_ONE, PATCH } from '@/app/api/admin/tickets/[id]/route';
import { POST as POST_MSG } from '@/app/api/admin/tickets/[id]/messages/route';
import { POST as POST_RESOLVE } from '@/app/api/admin/tickets/[id]/resolve/route';

const ADMIN = { role: 'superadmin', tenant_id: null, user: { id: 'adm', email: 'ops@x' }, viaBreakGlass: false };
const TID = '0b0b0b0b-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ticket = {
    id: TID,
    number: 7,
    category: 'billing',
    status: 'open',
    priority: 'normal',
    subject: 's',
    request_id: null,
    order_id: null,
    model: null,
    disputed_cny: null,
    resolution: null,
    credit_cny: null,
    reopen_count: 0,
    assignee: null,
    first_reply_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    resolved_at: null,
    closed_at: null,
    messages: [],
    events: [],
};
const req = (path: string, method: string, body?: unknown) =>
    new NextRequest(`https://x${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(ADMIN);
    svc.list.mockResolvedValue({ items: [], total: 0, counts: {} });
    svc.get.mockResolvedValue(ticket);
    svc.context.mockResolvedValue({ customer: {}, balance: null, recharges: [], logs: [], logs_error: null });
});

describe('admin tickets routes', () => {
    it('all routes require role ≥ admin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await GET(req('/api/admin/tickets', 'GET'))).status).toBe(401);
        expect((await GET_ONE(req(`/x/${TID}`, 'GET'), ctx(TID))).status).toBe(401);
        expect((await POST_MSG(req(`/x/${TID}/messages`, 'POST', { body: 'x' }), ctx(TID))).status).toBe(401);
        expect((await POST_RESOLVE(req(`/x/${TID}/resolve`, 'POST', { resolution: 'fixed' }), ctx(TID))).status).toBe(
            401,
        );
        expect(mockResolveAdmin).toHaveBeenCalledWith(expect.anything(), 'admin');
        expect(svc.list).not.toHaveBeenCalled();
    });
    it('GET list forwards filters, defaults status=open, rejects bad status', async () => {
        await GET(req('/api/admin/tickets?status=resolved&category=billing&q=T-7&page=2', 'GET'));
        expect(svc.list).toHaveBeenCalledWith(ADMIN, { status: 'resolved', category: 'billing', q: 'T-7', page: 2 });
        await GET(req('/api/admin/tickets', 'GET'));
        expect(svc.list).toHaveBeenLastCalledWith(ADMIN, expect.objectContaining({ status: 'open', page: 1 }));
        expect((await GET(req('/api/admin/tickets?status=nope', 'GET'))).status).toBe(400);
    });
    it('GET detail: bad uuid 404, not found 404, happy path includes context + internal messages', async () => {
        expect((await GET_ONE(req('/x/abc', 'GET'), ctx('abc'))).status).toBe(404);
        svc.get.mockRejectedValue(new TicketError('not_found', 404));
        expect((await GET_ONE(req(`/x/${TID}`, 'GET'), ctx(TID))).status).toBe(404);
        svc.get.mockResolvedValue({
            ...ticket,
            messages: [
                {
                    id: 'm1',
                    author_type: 'staff',
                    author_id: 'ops@x',
                    body: 'secret',
                    internal: true,
                    created_at: new Date(),
                },
            ],
        });
        const res = await GET_ONE(req(`/x/${TID}`, 'GET'), ctx(TID));
        const json = await res.json();
        expect(json.ticket.number).toBe('T-000007');
        expect(json.messages[0]).toMatchObject({ internal: true, author_id: 'ops@x' });
        expect(json.context).toBeDefined();
    });
    it('POST messages: validation + internal flag passthrough + 409 mapping', async () => {
        expect((await POST_MSG(req(`/x/${TID}/messages`, 'POST', { body: '' }), ctx(TID))).status).toBe(400);
        svc.reply.mockResolvedValue({
            id: 'm',
            author_type: 'staff',
            body: 'n',
            internal: true,
            created_at: new Date(),
        });
        const res = await POST_MSG(req(`/x/${TID}/messages`, 'POST', { body: 'n', internal: true }), ctx(TID));
        expect(res.status).toBe(201);
        expect(svc.reply).toHaveBeenCalledWith(ADMIN, TID, 'n', true);
        svc.reply.mockRejectedValue(new TicketError('invalid_state', 409));
        expect((await POST_MSG(req(`/x/${TID}/messages`, 'POST', { body: 'n' }), ctx(TID))).status).toBe(409);
    });
    it('POST resolve: credit cap 10000, happy path returns balance, credit_failed → 502', async () => {
        expect(
            (
                await POST_RESOLVE(
                    req(`/x/${TID}/resolve`, 'POST', { resolution: 'credited', credit_cny: 10001 }),
                    ctx(TID),
                )
            ).status,
        ).toBe(400);
        svc.resolve.mockResolvedValue({ ticket: { ...ticket, status: 'resolved' }, balance_after_cny: 9.5 });
        const res = await POST_RESOLVE(
            req(`/x/${TID}/resolve`, 'POST', { resolution: 'credited', credit_cny: 1.5, note: '' }),
            ctx(TID),
        );
        expect(res.status).toBe(200);
        expect(svc.resolve).toHaveBeenCalledWith(ADMIN, TID, {
            resolution: 'credited',
            creditCny: 1.5,
            note: undefined,
        });
        expect((await res.json()).balance_after_cny).toBe(9.5);
        svc.resolve.mockRejectedValue(new AdminTicketError('credit_failed', 502));
        expect(
            (await POST_RESOLVE(req(`/x/${TID}/resolve`, 'POST', { resolution: 'credited', credit_cny: 1 }), ctx(TID)))
                .status,
        ).toBe(502);
    });
    it('PATCH: resolution_required → 400 with the code', async () => {
        svc.update.mockRejectedValue(new AdminTicketError('resolution_required', 400));
        const res = await PATCH(req(`/x/${TID}`, 'PATCH', { status: 'closed' }), ctx(TID));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('resolution_required');
        svc.update.mockResolvedValue({ ...ticket, priority: 'high' });
        const ok = await PATCH(req(`/x/${TID}`, 'PATCH', { priority: 'high', assignee: null }), ctx(TID));
        expect(ok.status).toBe(200);
        expect(svc.update).toHaveBeenLastCalledWith(ADMIN, TID, { priority: 'high', assignee: null });
    });
});

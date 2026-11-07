/** /api/portal/tickets 路由层:鉴权 / zod / 错误码映射。业务逻辑在 service 测试里。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a) }));
vi.mock('@/lib/i18n/server', () => ({ getLocale: async () => 'zh' }));

const svc = {
    createTicket: vi.fn(),
    listTicketsForUser: vi.fn(),
    getTicketForUser: vi.fn(),
    addCustomerMessage: vi.fn(),
    confirmResolved: vi.fn(),
    reopenTicket: vi.fn(),
};
vi.mock('@/lib/tickets/service', async () => {
    const actual = await vi.importActual<typeof import('@/lib/tickets/service')>('@/lib/tickets/service');
    return {
        ...actual,
        createTicket: (...a: unknown[]) => svc.createTicket(...a),
        listTicketsForUser: (...a: unknown[]) => svc.listTicketsForUser(...a),
        getTicketForUser: (...a: unknown[]) => svc.getTicketForUser(...a),
        addCustomerMessage: (...a: unknown[]) => svc.addCustomerMessage(...a),
        confirmResolved: (...a: unknown[]) => svc.confirmResolved(...a),
        reopenTicket: (...a: unknown[]) => svc.reopenTicket(...a),
    };
});
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { TicketError } from '@/lib/tickets/service';
import { GET, POST } from '@/app/api/portal/tickets/route';
import { GET as GET_ONE } from '@/app/api/portal/tickets/[id]/route';
import { POST as POST_MSG } from '@/app/api/portal/tickets/[id]/messages/route';
import { POST as POST_REOPEN } from '@/app/api/portal/tickets/[id]/reopen/route';

const USER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email: 'c@test.io', locale: 'zh-CN' };
const TID = '0b0b0b0b-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ticket = {
    id: TID,
    number: 3,
    category: 'other',
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
    created_at: new Date('2026-11-07T00:00:00Z'),
    updated_at: new Date('2026-11-07T00:00:00Z'),
    resolved_at: null,
    closed_at: null,
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
    mockGetCurrentUser.mockResolvedValue(USER);
    svc.listTicketsForUser.mockResolvedValue([]);
    svc.createTicket.mockResolvedValue(ticket);
});

describe('GET /api/portal/tickets', () => {
    it('401 without session', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        expect((await GET(req('/api/portal/tickets', 'GET'))).status).toBe(401);
    });
    it('passes the status filter, defaults to active on junk', async () => {
        await GET(req('/api/portal/tickets?status=resolved', 'GET'));
        expect(svc.listTicketsForUser).toHaveBeenCalledWith(USER.id, 'resolved');
        await GET(req('/api/portal/tickets?status=nope', 'GET'));
        expect(svc.listTicketsForUser).toHaveBeenLastCalledWith(USER.id, 'active');
    });
});

describe('POST /api/portal/tickets', () => {
    const good = {
        category: 'api_error',
        subject: 'timeout on gpt-5.5',
        body: 'every request hangs for 60s then 504',
        request_id: 'RID1234567890',
    };
    it('201 + serialized ticket', async () => {
        const res = await POST(req('/api/portal/tickets', 'POST', good));
        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.ticket).toMatchObject({ id: TID, number: 'T-000003', status: 'open' });
        expect(svc.createTicket).toHaveBeenCalledWith(
            USER,
            expect.objectContaining({ category: 'api_error', requestId: 'RID1234567890', orderId: undefined }),
            expect.objectContaining({ locale: 'zh' }),
        );
    });
    it('400 invalid_json / invalid_input / invalid_request_id', async () => {
        const bad = new NextRequest('https://x/api/portal/tickets', { method: 'POST', body: '{nope' });
        expect((await POST(bad)).status).toBe(400);
        const r2 = await POST(req('/api/portal/tickets', 'POST', { ...good, body: 'short' }));
        expect(r2.status).toBe(400);
        expect((await r2.json()).error).toBe('invalid_input');
        const r3 = await POST(req('/api/portal/tickets', 'POST', { ...good, request_id: 'bad id!' }));
        expect((await r3.json()).error).toBe('invalid_request_id');
        expect(svc.createTicket).not.toHaveBeenCalled();
    });
    it('blank optional strings are dropped, disputed_cny coerced', async () => {
        await POST(
            req('/api/portal/tickets', 'POST', { ...good, category: 'billing', order_id: '', disputed_cny: '1.5' }),
        );
        expect(svc.createTicket.mock.calls[0][1]).toMatchObject({ orderId: undefined, disputedCny: 1.5 });
    });
    it('maps TicketError codes to their status', async () => {
        svc.createTicket.mockRejectedValue(new TicketError('too_many_open_tickets', 429));
        const res = await POST(req('/api/portal/tickets', 'POST', good));
        expect(res.status).toBe(429);
        expect((await res.json()).error).toBe('too_many_open_tickets');
    });
    it('unexpected errors → 500 internal_error', async () => {
        svc.createTicket.mockRejectedValue(new Error('db down'));
        expect((await POST(req('/api/portal/tickets', 'POST', good))).status).toBe(500);
    });
});

describe('/api/portal/tickets/[id]*', () => {
    it('non-uuid id → 404 before touching the service', async () => {
        expect((await GET_ONE(req('/api/portal/tickets/abc', 'GET'), ctx('abc'))).status).toBe(404);
        expect(svc.getTicketForUser).not.toHaveBeenCalled();
    });
    it('detail returns ticket + messages + events, 404 when not mine', async () => {
        svc.getTicketForUser.mockResolvedValue({
            ...ticket,
            messages: [{ id: 'm1', author_type: 'customer', body: 'hi', created_at: new Date() }],
            events: [{ id: 'e1', type: 'created', payload: {}, created_at: new Date() }],
        });
        const res = await GET_ONE(req(`/api/portal/tickets/${TID}`, 'GET'), ctx(TID));
        const json = await res.json();
        expect(json.messages).toHaveLength(1);
        expect(json.events[0].type).toBe('created');
        svc.getTicketForUser.mockResolvedValue(null);
        expect((await GET_ONE(req(`/api/portal/tickets/${TID}`, 'GET'), ctx(TID))).status).toBe(404);
    });
    it('messages: empty body 400, success 201, invalid_state 409 passthrough', async () => {
        expect(
            (await POST_MSG(req(`/api/portal/tickets/${TID}/messages`, 'POST', { body: '  ' }), ctx(TID))).status,
        ).toBe(400);
        svc.addCustomerMessage.mockResolvedValue({
            id: 'm2',
            author_type: 'customer',
            body: 'x',
            created_at: new Date(),
        });
        expect(
            (await POST_MSG(req(`/api/portal/tickets/${TID}/messages`, 'POST', { body: 'x' }), ctx(TID))).status,
        ).toBe(201);
        svc.addCustomerMessage.mockRejectedValue(new TicketError('invalid_state', 409));
        expect(
            (await POST_MSG(req(`/api/portal/tickets/${TID}/messages`, 'POST', { body: 'x' }), ctx(TID))).status,
        ).toBe(409);
    });
    it('reopen requires a body and forwards it', async () => {
        svc.reopenTicket.mockResolvedValue({ ...ticket, status: 'open', reopen_count: 1 });
        const res = await POST_REOPEN(
            req(`/api/portal/tickets/${TID}/reopen`, 'POST', { body: 'still broken' }),
            ctx(TID),
        );
        expect(res.status).toBe(200);
        expect(svc.reopenTicket).toHaveBeenCalledWith(TID, USER, 'still broken', undefined);
    });
});

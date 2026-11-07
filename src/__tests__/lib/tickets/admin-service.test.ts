/** 管理员侧工单 service:租户隔离 / 回复状态机 / 处置补额顺序 / 关闭守卫。prisma 内存 mock。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminPrincipal } from '@/lib/admin/auth';

const db = vi.hoisted(() => ({
    ticket: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    ticketMessage: { create: vi.fn() },
    ticketEvent: { create: vi.fn(), createMany: vi.fn() },
    rechargeLog: { findMany: vi.fn() },
    $transaction: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
const mockAdjust = vi.fn();
vi.mock('@/lib/billing/admin-adjust', () => ({ adjustCustomerBalance: (...a: unknown[]) => mockAdjust(...a) }));
const mockSendUpdated = vi.fn();
vi.mock('@/lib/email/send', () => ({ sendTicketUpdatedEmail: (...a: unknown[]) => mockSendUpdated(...a) }));
const mockQuota = vi.fn();
vi.mock('@/lib/newapi/quota-cache', () => ({ getQuotaWithCache: (...a: unknown[]) => mockQuota(...a) }));
const mockQueryLogs = vi.fn();
vi.mock('@/lib/newapi/client', () => ({ queryLogs: (...a: unknown[]) => mockQueryLogs(...a) }));
vi.mock('@/lib/newapi/quota-units', () => ({ quotaToCny: (q: number) => q / 500_000 }));

import {
    AdminTicketError,
    getTicketContext,
    listTicketsAdmin,
    resolveTicketAdmin,
    searchWhere,
    staffReply,
    updateTicketAdmin,
} from '@/lib/tickets/admin-service';
import { TicketError } from '@/lib/tickets/service';

const SUPER: AdminPrincipal = {
    user: { id: 'adm1', email: 'ops@silkroadai.io' } as never,
    role: 'superadmin',
    tenant_id: null,
    viaBreakGlass: false,
};
const PARTNER: AdminPrincipal = {
    user: { id: 'adm2', email: 'p@acme.com' } as never,
    role: 'admin',
    tenant_id: 'tttttttt-0000-4000-8000-000000000001',
    viaBreakGlass: false,
};
const TID = '0b0b0b0b-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const user = {
    id: 'u1',
    email: 'c@test.io',
    locale: 'zh-CN',
    tenant_id: null,
    billing_mode: 'newapi',
    newapi_user_id: 40,
    nickname: null,
    newapi_username: 'c-u1',
    status: 'active',
    created_at: new Date(),
};
const ticket = {
    id: TID,
    number: 7,
    subject: 'subj',
    status: 'open',
    priority: 'normal',
    resolution: null,
    credit_cny: null,
    first_reply_at: null,
    assignee: null,
    request_id: 'RID1234567890',
    user,
};

beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (arg: unknown) =>
        typeof arg === 'function'
            ? (arg as (tx: typeof db) => Promise<unknown>)(db)
            : Promise.all(arg as Promise<unknown>[]),
    );
    db.ticket.findMany.mockResolvedValue([]);
    db.ticket.count.mockResolvedValue(0);
    db.ticket.groupBy.mockResolvedValue([{ status: 'open', _count: { _all: 2 } }]);
    db.ticket.findFirst.mockResolvedValue({ ...ticket });
    db.ticket.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...ticket,
        ...data,
    }));
    db.ticketMessage.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'm',
        created_at: new Date(),
        ...data,
    }));
    db.ticketEvent.create.mockResolvedValue({});
    db.ticketEvent.createMany.mockResolvedValue({ count: 1 });
    db.rechargeLog.findMany.mockResolvedValue([]);
    mockSendUpdated.mockResolvedValue(null);
    mockAdjust.mockResolvedValue({ billing_mode: 'newapi', balance_cny: 12.5, quota_before: 0, quota_after: 0 });
});

describe('searchWhere', () => {
    it('T-000123 → number; uuid → id; request-id-shaped → request_id OR email; else email contains', () => {
        expect(searchWhere('T-000123')).toEqual({ number: 123 });
        expect(searchWhere('t7')).toEqual({ number: 7 });
        expect(searchWhere(TID)).toEqual({ id: TID });
        expect(searchWhere('RID1234567890')).toMatchObject({
            OR: [{ request_id: 'RID1234567890' }, expect.anything()],
        });
        expect(searchWhere('foo@bar')).toEqual({ user: { email: { contains: 'foo@bar', mode: 'insensitive' } } });
    });
});

describe('listTicketsAdmin', () => {
    it('superadmin sees everything; open queue ordered by customer wait', async () => {
        const r = await listTicketsAdmin(SUPER, { status: 'open', page: 1 });
        const call = db.ticket.findMany.mock.calls[0][0];
        expect(call.where).toEqual({ status: 'open' });
        expect(call.orderBy[0]).toEqual({ last_customer_msg_at: 'asc' });
        expect(r.counts.open).toBe(2);
        expect(r.counts.closed).toBe(0);
    });
    it('partner admin is tenant-scoped (list + counts)', async () => {
        await listTicketsAdmin(PARTNER, { status: 'all', category: 'billing', q: 'T-7', page: 2 });
        const call = db.ticket.findMany.mock.calls[0][0];
        expect(call.where).toEqual({ tenant_id: PARTNER.tenant_id, category: 'billing', number: 7 });
        expect(call.skip).toBe(50);
        expect(db.ticket.groupBy.mock.calls[0][0].where).toEqual({ tenant_id: PARTNER.tenant_id });
    });
});

describe('staffReply', () => {
    it('visible reply: open → waiting_customer, first_reply_at set, email with excerpt', async () => {
        await staffReply(SUPER, TID, 'we are on it', false);
        expect(db.ticketMessage.create.mock.calls[0][0].data).toMatchObject({
            author_type: 'staff',
            author_id: 'ops@silkroadai.io',
            internal: false,
        });
        const upd = db.ticket.update.mock.calls[0][0].data;
        expect(upd.status).toBe('waiting_customer');
        expect(upd.first_reply_at).toBeInstanceOf(Date);
        expect(db.ticketEvent.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ type: 'status_changed', actor: 'staff:ops@silkroadai.io' }),
            }),
        );
        await Promise.resolve();
        expect(mockSendUpdated).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'staff_reply',
                to: 'c@test.io',
                number: 'T-000007',
                excerpt: 'we are on it',
            }),
        );
    });
    it('internal note: no status change, no email; allowed even when closed', async () => {
        db.ticket.findFirst.mockResolvedValue({ ...ticket, status: 'closed' });
        await staffReply(SUPER, TID, 'note', true);
        expect(db.ticket.update).not.toHaveBeenCalled();
        expect(mockSendUpdated).not.toHaveBeenCalled();
    });
    it('visible reply on closed → invalid_state; other tenant → not_found', async () => {
        db.ticket.findFirst.mockResolvedValue({ ...ticket, status: 'closed' });
        await expect(staffReply(SUPER, TID, 'x', false)).rejects.toMatchObject({ code: 'invalid_state' });
        db.ticket.findFirst.mockResolvedValue(null);
        await expect(staffReply(PARTNER, TID, 'x', false)).rejects.toBeInstanceOf(TicketError);
        expect(db.ticket.findFirst).toHaveBeenLastCalledWith(
            expect.objectContaining({ where: { tenant_id: PARTNER.tenant_id, id: TID } }),
        );
    });
});

describe('resolveTicketAdmin', () => {
    it('credit: adjustCustomerBalance BEFORE the ticket tx, note carries ticket number, credited + status events, email resolved', async () => {
        const r = await resolveTicketAdmin(SUPER, TID, { resolution: 'credited', creditCny: 1.52, note: '已核实补额' });
        expect(mockAdjust).toHaveBeenCalledWith(
            user,
            expect.objectContaining({
                amountCny: 1.52,
                note: '工单 T-000007 补额:已核实补额',
                adjustedBy: 'adm1',
                extra: { ticket_id: TID },
            }),
        );
        expect(mockAdjust.mock.invocationCallOrder[0]).toBeLessThan(db.ticket.update.mock.invocationCallOrder[0]);
        const upd = db.ticket.update.mock.calls[0][0].data;
        expect(upd.status).toBe('resolved');
        expect(upd.resolution).toBe('credited');
        expect(String(upd.credit_cny)).toBe('1.52');
        expect(db.ticketMessage.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ body: '已核实补额', author_type: 'staff' }) }),
        );
        const types = db.ticketEvent.create.mock.calls.map((c) => c[0].data.type);
        expect(types).toEqual(['credited', 'status_changed']);
        expect(r.balance_after_cny).toBe(12.5);
        await Promise.resolve();
        expect(mockSendUpdated).toHaveBeenCalledWith(expect.objectContaining({ kind: 'resolved' }));
    });
    it('no credit: no adjust call, no credited event, credit_cny untouched', async () => {
        await resolveTicketAdmin(SUPER, TID, { resolution: 'explained' });
        expect(mockAdjust).not.toHaveBeenCalled();
        expect(db.ticket.update.mock.calls[0][0].data.credit_cny).toBeUndefined();
        expect(db.ticketEvent.create.mock.calls.map((c) => c[0].data.type)).toEqual(['status_changed']);
    });
    it('credit failure → credit_failed 502 and the ticket is NOT touched', async () => {
        mockAdjust.mockRejectedValue(new Error('new-api down'));
        await expect(resolveTicketAdmin(SUPER, TID, { resolution: 'credited', creditCny: 5 })).rejects.toMatchObject({
            code: 'credit_failed',
            status: 502,
        });
        expect(db.ticket.update).not.toHaveBeenCalled();
        expect(mockSendUpdated).not.toHaveBeenCalled();
    });
    it('closed ticket → invalid_state; negative amount → invalid_amount', async () => {
        db.ticket.findFirst.mockResolvedValue({ ...ticket, status: 'closed' });
        await expect(resolveTicketAdmin(SUPER, TID, { resolution: 'fixed' })).rejects.toMatchObject({
            code: 'invalid_state',
        });
        db.ticket.findFirst.mockResolvedValue({ ...ticket });
        await expect(resolveTicketAdmin(SUPER, TID, { resolution: 'credited', creditCny: -1 })).rejects.toBeInstanceOf(
            AdminTicketError,
        );
    });
});

describe('updateTicketAdmin', () => {
    it('close without any resolution → resolution_required', async () => {
        await expect(updateTicketAdmin(SUPER, TID, { status: 'closed' })).rejects.toMatchObject({
            code: 'resolution_required',
            status: 400,
        });
        expect(db.ticket.update).not.toHaveBeenCalled();
    });
    it('close with resolution → closed + closed_at + status event + email', async () => {
        await updateTicketAdmin(SUPER, TID, { status: 'closed', resolution: 'rejected' });
        const upd = db.ticket.update.mock.calls[0][0].data;
        expect(upd).toMatchObject({ status: 'closed', resolution: 'rejected' });
        expect(upd.closed_at).toBeInstanceOf(Date);
        expect(db.ticketEvent.createMany.mock.calls[0][0].data.map((e: { type: string }) => e.type)).toEqual([
            'status_changed',
        ]);
        await Promise.resolve();
        expect(mockSendUpdated).toHaveBeenCalledWith(expect.objectContaining({ kind: 'closed' }));
    });
    it('priority + assignee change writes two events, no email; no-op when unchanged', async () => {
        await updateTicketAdmin(SUPER, TID, { priority: 'high', assignee: 'alice' });
        expect(db.ticketEvent.createMany.mock.calls[0][0].data.map((e: { type: string }) => e.type)).toEqual([
            'priority_changed',
            'assigned',
        ]);
        expect(mockSendUpdated).not.toHaveBeenCalled();
        vi.clearAllMocks();
        db.ticket.findFirst.mockResolvedValue({ ...ticket });
        await updateTicketAdmin(SUPER, TID, { priority: 'normal', assignee: null });
        expect(db.ticket.update).not.toHaveBeenCalled();
    });
    it('staff reopen from closed → open and timestamps cleared', async () => {
        db.ticket.findFirst.mockResolvedValue({ ...ticket, status: 'closed' });
        await updateTicketAdmin(SUPER, TID, { status: 'open' });
        expect(db.ticket.update.mock.calls[0][0].data).toMatchObject({
            status: 'open',
            resolved_at: null,
            closed_at: null,
        });
    });
});

describe('getTicketContext', () => {
    it('balance / recharges / logs with request_id match; each block degrades independently', async () => {
        mockQuota.mockResolvedValue({ remain_quota: 1_000_000, used_quota: 500_000, source: 'cache' });
        db.ticket.count.mockResolvedValue(3);
        mockQueryLogs.mockResolvedValue({
            items: [
                {
                    user_id: 40,
                    type: 2,
                    created_at: 1,
                    model_name: 'gpt-5.5',
                    request_id: 'RID1234567890',
                    token_name: 'k',
                    quota: 50_000,
                    content: '',
                },
                {
                    user_id: 41,
                    type: 2,
                    created_at: 2,
                    model_name: 'other-user',
                    request_id: 'x',
                    token_name: 'k',
                    quota: 1,
                    content: '',
                },
                {
                    user_id: 40,
                    type: 5,
                    created_at: 3,
                    model_name: 'gpt-5.5',
                    request_id: 'RIDzzz',
                    token_name: 'k',
                    quota: 0,
                    content: 'boom',
                },
            ],
            total: 3,
        });
        const ctx = await getTicketContext({ ...ticket, user } as never);
        expect(ctx.balance).toMatchObject({ remain_cny: 2, used_cny: 1, source: 'cache' });
        expect(ctx.customer.ticket_count).toBe(3);
        expect(ctx.logs).toHaveLength(2);
        expect(ctx.logs[0]).toMatchObject({ matched: true, costCny: 0.1, failed: false });
        expect(ctx.logs[1]).toMatchObject({ matched: false, failed: true });
        mockQuota.mockRejectedValue(new Error('no'));
        mockQueryLogs.mockRejectedValue(new Error('502'));
        const degraded = await getTicketContext({ ...ticket, user } as never);
        expect(degraded.balance).toBeNull();
        expect(degraded.logs).toEqual([]);
        expect(degraded.logs_error).toContain('502');
    });
});

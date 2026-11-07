/**
 * 工单客户侧 service — 名额 / 频率 / 状态机守卫 + 提交后 best-effort 动作(定位 + 邮件)。
 * prisma 用内存 mock:$transaction(fn) 直接把同一组 mock 当 tx 传进去。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';

const db = vi.hoisted(() => ({
    ticket: { count: vi.fn(), create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    ticketMessage: { create: vi.fn() },
    ticketEvent: { create: vi.fn() },
    order: { findFirst: vi.fn() },
    newApiToken: { findFirst: vi.fn() },
    user: { update: vi.fn() },
    $transaction: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));

const mockSendCreated = vi.fn();
vi.mock('@/lib/email/send', () => ({ sendTicketCreatedEmail: (...a: unknown[]) => mockSendCreated(...a) }));

const mockLocate = vi.fn();
vi.mock('@/lib/tickets/lookup', () => ({ locateRequest: (...a: unknown[]) => mockLocate(...a) }));

import { addCustomerMessage, confirmResolved, createTicket, reopenTicket, TicketError } from '@/lib/tickets/service';

const user = {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    email: 'c@test.io',
    locale: 'zh-CN',
    tenant_id: null,
    newapi_user_id: 40,
    newapi_username: 'c-aaaaaaaa',
} as unknown as User;

const baseTicket = {
    id: '0b0b0b0b-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    number: 12,
    user_id: user.id,
    subject: 'gpt-5.5 charged but empty',
    status: 'open',
    reopen_count: 0,
};

beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: typeof db) => Promise<unknown>)(db);
        return Promise.all(arg as Promise<unknown>[]);
    });
    db.ticket.count.mockResolvedValue(0);
    db.ticket.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...baseTicket,
        ...data,
    }));
    db.ticket.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...baseTicket,
        ...data,
    }));
    db.ticketMessage.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'm1',
        created_at: new Date(),
        ...data,
    }));
    db.ticketEvent.create.mockResolvedValue({});
    db.user.update.mockResolvedValue({});
    db.newApiToken.findFirst.mockResolvedValue(null);
    mockSendCreated.mockResolvedValue(null);
    mockLocate.mockResolvedValue(null);
});

const opts = { locale: 'zh' as const, appUrl: 'https://silkroadai.io' };

describe('createTicket', () => {
    it('billing without request_id → request_id_required (no DB write)', async () => {
        await expect(
            createTicket(user, { category: 'billing', subject: 'x'.repeat(5), body: 'y'.repeat(20) }, opts),
        ).rejects.toMatchObject({ code: 'request_id_required', status: 400 });
        expect(db.ticket.create).not.toHaveBeenCalled();
    });
    it('5 active tickets → too_many_open_tickets 429', async () => {
        db.ticket.count.mockResolvedValueOnce(5).mockResolvedValueOnce(0);
        await expect(
            createTicket(user, { category: 'other', subject: 'subj', body: 'y'.repeat(20) }, opts),
        ).rejects.toMatchObject({
            code: 'too_many_open_tickets',
            status: 429,
        });
    });
    it('3 tickets in the last hour → rate_limited 429', async () => {
        db.ticket.count.mockResolvedValueOnce(1).mockResolvedValueOnce(3);
        await expect(
            createTicket(user, { category: 'other', subject: 'subj', body: 'y'.repeat(20) }, opts),
        ).rejects.toMatchObject({
            code: 'rate_limited',
        });
    });
    it('order_id that is not the user’s → order_not_found', async () => {
        db.order.findFirst.mockResolvedValue(null);
        await expect(
            createTicket(user, { category: 'recharge', subject: 'subj', body: 'y'.repeat(20), orderId: 'ord1' }, opts),
        ).rejects.toMatchObject({ code: 'order_not_found' });
        expect(db.order.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'ord1', user_id: user.id } }),
        );
    });
    it('happy path: creates ticket + first message + created event, remembers locale, emails the customer', async () => {
        const t = await createTicket(
            user,
            { category: 'account', subject: 'key disabled', body: 'my key stopped working today' },
            { ...opts, locale: 'en' },
        );
        expect(t.subject).toBe('key disabled');
        const data = db.ticket.create.mock.calls[0][0].data;
        expect(data.messages.create).toMatchObject({
            author_type: 'customer',
            author_id: user.id,
            body: 'my key stopped working today',
        });
        expect(data.events.create).toMatchObject({ type: 'created', actor: `customer:${user.id}` });
        expect(data.last_customer_msg_at).toBeInstanceOf(Date);
        // locale zh-CN → en because the site was in English when the ticket was filed
        expect(db.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { locale: 'en' } }));
        await Promise.resolve();
        expect(mockSendCreated).toHaveBeenCalledWith(
            expect.objectContaining({
                to: 'c@test.io',
                locale: 'en',
                number: 'T-000012',
                ticketUrl: `https://silkroadai.io/support/${baseTicket.id}`,
            }),
        );
    });
    it('with request_id: locates the call and backfills model / disputed amount + request_located event', async () => {
        mockLocate.mockResolvedValue({
            requestId: 'RID1234567890',
            model: 'gpt-5.5',
            newapiTokenId: 77,
            quota: 85000,
            costCny: 0.1234,
            createdAt: 1_750_000_000,
            failed: false,
            content: '',
        });
        db.newApiToken.findFirst.mockResolvedValue({ id: 'kkkkkkkk-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
        await createTicket(
            user,
            { category: 'billing', subject: 'subj', body: 'y'.repeat(20), requestId: 'RID1234567890' },
            opts,
        );
        expect(mockLocate).toHaveBeenCalledWith(user, 'RID1234567890');
        const upd = db.ticket.update.mock.calls[0][0];
        expect(upd.data.model).toBe('gpt-5.5');
        expect(upd.data.token_id).toBe('kkkkkkkk-bbbb-4ccc-8ddd-eeeeeeeeeeee');
        expect(String(upd.data.disputed_cny)).toBe('0.1234');
        expect(db.ticketEvent.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    type: 'request_located',
                    payload: expect.objectContaining({ model: 'gpt-5.5', failed: false }),
                }),
            }),
        );
    });
    it('email failure never fails the create', async () => {
        mockSendCreated.mockRejectedValue(new Error('smtp down'));
        await expect(
            createTicket(user, { category: 'other', subject: 'subj', body: 'y'.repeat(20) }, opts),
        ).resolves.toBeTruthy();
    });
});

describe('customer actions', () => {
    it('attachments: foreign key → attachment_not_owned; own keys stored on the message', async () => {
        const own = {
            key: `tickets/${user.id}/0b0b0b0b-bbbb-4ccc-8ddd-eeeeeeeeeeee.png`,
            name: 'a.png',
            size: 10,
            type: 'image/png' as const,
        };
        const foreign = {
            ...own,
            key: 'tickets/0b0b0b0b-bbbb-4ccc-8ddd-eeeeeeeeeeee/0b0b0b0b-bbbb-4ccc-8ddd-eeeeeeeeeeee.png',
        };
        db.ticket.findFirst.mockResolvedValue({ ...baseTicket, status: 'open' });
        await expect(addCustomerMessage(baseTicket.id, user, 'x', [foreign])).rejects.toMatchObject({
            code: 'attachment_not_owned',
            status: 400,
        });
        await addCustomerMessage(baseTicket.id, user, 'x', [own]);
        expect(db.ticketMessage.create.mock.calls[0][0].data.attachments).toEqual([own]);
        await expect(
            createTicket(
                user,
                { category: 'other', subject: 'subj', body: 'y'.repeat(20), attachments: [foreign] },
                opts,
            ),
        ).rejects.toMatchObject({ code: 'attachment_not_owned' });
    });
    it('addCustomerMessage: waiting_customer → open + status_changed event', async () => {
        db.ticket.findFirst.mockResolvedValue({ ...baseTicket, status: 'waiting_customer' });
        await addCustomerMessage(baseTicket.id, user, 'more details');
        expect(db.ticket.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'open' }) }),
        );
        expect(db.ticketEvent.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ type: 'status_changed' }) }),
        );
    });
    it('addCustomerMessage on a closed ticket → invalid_state 409', async () => {
        db.ticket.findFirst.mockResolvedValue({ ...baseTicket, status: 'closed' });
        await expect(addCustomerMessage(baseTicket.id, user, 'x')).rejects.toMatchObject({
            code: 'invalid_state',
            status: 409,
        });
    });
    it('someone else’s ticket → not_found (IDOR)', async () => {
        db.ticket.findFirst.mockResolvedValue(null);
        await expect(addCustomerMessage(baseTicket.id, user, 'x')).rejects.toBeInstanceOf(TicketError);
        expect(db.ticket.findFirst).toHaveBeenCalledWith({ where: { id: baseTicket.id, user_id: user.id } });
    });
    it('confirmResolved only from resolved', async () => {
        db.ticket.findFirst.mockResolvedValue({ ...baseTicket, status: 'open' });
        await expect(confirmResolved(baseTicket.id, user)).rejects.toMatchObject({ code: 'invalid_state' });
        db.ticket.findFirst.mockResolvedValue({ ...baseTicket, status: 'resolved' });
        const t = await confirmResolved(baseTicket.id, user);
        expect(t.status).toBe('closed');
        expect(db.ticket.update.mock.calls[0][0].data.closed_at).toBeInstanceOf(Date);
    });
    it('reopen increments the counter and is refused after 3 reopens', async () => {
        db.ticket.findFirst.mockResolvedValue({ ...baseTicket, status: 'resolved', reopen_count: 1 });
        await reopenTicket(baseTicket.id, user, 'still broken');
        expect(db.ticket.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: 'open', reopen_count: { increment: 1 }, resolved_at: null }),
            }),
        );
        db.ticket.findFirst.mockResolvedValue({ ...baseTicket, status: 'resolved', reopen_count: 3 });
        await expect(reopenTicket(baseTicket.id, user, 'again')).rejects.toMatchObject({
            code: 'reopen_limit',
            status: 409,
        });
    });
});

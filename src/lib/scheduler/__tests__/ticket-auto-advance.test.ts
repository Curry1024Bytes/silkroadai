import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ ticket: { findMany: vi.fn(), updateMany: vi.fn() }, ticketEvent: { create: vi.fn() } }));
vi.mock('@/lib/db', () => ({ prisma: db }));
const mockSend = vi.fn();
vi.mock('@/lib/email/send', () => ({ sendTicketUpdatedEmail: (...a: unknown[]) => mockSend(...a) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { scanAndAdvance } from '@/lib/scheduler/ticket-auto-advance';

const NOW = new Date('2026-11-14T00:00:00Z');
const user = { email: 'c@test.io', locale: 'en' };

beforeEach(() => {
    vi.clearAllMocks();
    db.ticketEvent.create.mockResolvedValue({});
    mockSend.mockResolvedValue(null);
});

describe('ticket auto-advance', () => {
    it('queries both stale shapes with a 7-day cutoff', async () => {
        db.ticket.findMany.mockResolvedValue([]);
        await scanAndAdvance(NOW);
        const where = db.ticket.findMany.mock.calls[0][0].where;
        const cutoff = new Date('2026-11-07T00:00:00Z');
        expect(where.OR[0]).toEqual({ status: 'waiting_customer', last_staff_msg_at: { lt: cutoff } });
        expect(where.OR[1]).toEqual({ status: 'resolved', resolved_at: { lt: cutoff } });
    });
    it('waiting_customer → resolved (auto_resolved + email), resolved → closed (auto_closed + email)', async () => {
        db.ticket.findMany.mockResolvedValue([
            { id: 'a', number: 1, subject: 's1', status: 'waiting_customer', user },
            { id: 'b', number: 2, subject: 's2', status: 'resolved', user },
        ]);
        db.ticket.updateMany.mockResolvedValue({ count: 1 });
        const r = await scanAndAdvance(NOW);
        expect(r).toEqual({ autoResolved: 1, autoClosed: 1, raceLost: 0, errors: 0 });
        expect(db.ticket.updateMany.mock.calls[0][0]).toMatchObject({
            where: { id: 'a', status: 'waiting_customer' },
            data: { status: 'resolved', resolved_at: NOW },
        });
        expect(db.ticket.updateMany.mock.calls[1][0]).toMatchObject({
            where: { id: 'b', status: 'resolved' },
            data: { status: 'closed', closed_at: NOW },
        });
        expect(db.ticketEvent.create.mock.calls.map((c) => c[0].data.payload.reason)).toEqual([
            'auto_resolved',
            'auto_closed',
        ]);
        expect(mockSend.mock.calls.map((c) => c[0].kind)).toEqual(['resolved', 'closed']);
        expect(mockSend.mock.calls[0][0]).toMatchObject({ to: 'c@test.io', locale: 'en', number: 'T-000001' });
    });
    it('CAS lost (another instance already advanced) → no event, no email', async () => {
        db.ticket.findMany.mockResolvedValue([{ id: 'a', number: 1, subject: 's', status: 'waiting_customer', user }]);
        db.ticket.updateMany.mockResolvedValue({ count: 0 });
        const r = await scanAndAdvance(NOW);
        expect(r.raceLost).toBe(1);
        expect(db.ticketEvent.create).not.toHaveBeenCalled();
        expect(mockSend).not.toHaveBeenCalled();
    });
    it('one failing ticket does not stop the batch; email failure is swallowed', async () => {
        db.ticket.findMany.mockResolvedValue([
            { id: 'a', number: 1, subject: 's', status: 'resolved', user },
            { id: 'b', number: 2, subject: 's', status: 'resolved', user },
        ]);
        db.ticket.updateMany.mockRejectedValueOnce(new Error('db')).mockResolvedValueOnce({ count: 1 });
        mockSend.mockRejectedValue(new Error('smtp'));
        const r = await scanAndAdvance(NOW);
        expect(r).toMatchObject({ errors: 1, autoClosed: 1 });
    });
});

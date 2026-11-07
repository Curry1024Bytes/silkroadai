import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ ticket: { count: vi.fn(), findFirst: vi.fn() } }));
vi.mock('@/lib/db', () => ({ prisma: db }));
const cfg = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('@/lib/system-config', () => ({
    getSystemConfigs: (...a: unknown[]) => cfg.get(...a),
    setSystemConfigs: (...a: unknown[]) => cfg.set(...a),
}));

import type { AdminPrincipal } from '@/lib/admin/auth';
import { getTicketSla, getTicketSlaStats, setTicketSla, SLA_KEYS } from '@/lib/tickets/sla';

const SUPER: AdminPrincipal = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const PARTNER: AdminPrincipal = {
    role: 'admin',
    tenant_id: 'tttttttt-0000-4000-8000-000000000001',
    user: null,
    viaBreakGlass: false,
};
const NOW = new Date('2026-11-07T12:00:00Z');

beforeEach(() => {
    vi.clearAllMocks();
    cfg.get.mockResolvedValue({});
    db.ticket.count.mockResolvedValue(0);
    db.ticket.findFirst.mockResolvedValue(null);
});

describe('ticket SLA', () => {
    it('defaults 4h / 24h; honours stored values; rejects junk', async () => {
        expect(await getTicketSla()).toEqual({ firstReplyHours: 4, resolveHours: 24 });
        cfg.get.mockResolvedValue({ [SLA_KEYS.firstReply]: '8', [SLA_KEYS.resolve]: 'abc' });
        expect(await getTicketSla()).toEqual({ firstReplyHours: 8, resolveHours: 24 });
        cfg.get.mockRejectedValue(new Error('db'));
        expect(await getTicketSla()).toEqual({ firstReplyHours: 4, resolveHours: 24 });
    });
    it('setTicketSla writes both keys under group tickets', async () => {
        await setTicketSla({ firstReplyHours: 2, resolveHours: 48 });
        expect(
            cfg.set.mock.calls[0][0].map((c: { key: string; value: string; group: string }) => [
                c.key,
                c.value,
                c.group,
            ]),
        ).toEqual([
            [SLA_KEYS.firstReply, '2', 'tickets'],
            [SLA_KEYS.resolve, '48', 'tickets'],
        ]);
    });
    it('stats use tenant scope + cutoffs; oldest open wait in hours', async () => {
        db.ticket.count
            .mockResolvedValueOnce(3)
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(2)
            .mockResolvedValueOnce(1);
        db.ticket.findFirst.mockResolvedValue({
            last_customer_msg_at: new Date('2026-11-07T06:00:00Z'),
            created_at: new Date('2026-11-06T00:00:00Z'),
        });
        const s = await getTicketSlaStats(PARTNER, NOW);
        expect(s).toMatchObject({
            open: 3,
            waitingCustomer: 1,
            breachedFirstReply: 2,
            breachedResolve: 1,
            oldestOpenHours: 6,
        });
        const firstReplyWhere = db.ticket.count.mock.calls[2][0].where;
        expect(firstReplyWhere).toMatchObject({
            tenant_id: PARTNER.tenant_id,
            status: 'open',
            first_reply_at: null,
            created_at: { lt: new Date('2026-11-07T08:00:00Z') },
        });
        expect(db.ticket.count.mock.calls[3][0].where.created_at).toEqual({ lt: new Date('2026-11-06T12:00:00Z') });
        db.ticket.findFirst.mockResolvedValue(null);
        const s2 = await getTicketSlaStats(SUPER, NOW);
        expect(s2.oldestOpenHours).toBe(0);
        expect(db.ticket.count.mock.calls[4][0].where).toEqual({ status: 'open' });
    });
});

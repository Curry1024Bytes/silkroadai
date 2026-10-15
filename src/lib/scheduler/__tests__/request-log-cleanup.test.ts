import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db } = vi.hoisted(() => ({
    db: { requestLog: { findMany: vi.fn(), deleteMany: vi.fn() } },
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { sweepExpiredCustomerRequestLogs } from '../request-log-cleanup';

beforeEach(() => vi.clearAllMocks());

describe('sweepExpiredCustomerRequestLogs', () => {
    it('只查询已到期记录，并按 id 批量删除', async () => {
        const now = new Date('2026-10-22T00:00:00Z');
        db.requestLog.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
        db.requestLog.deleteMany.mockResolvedValue({ count: 2 });
        expect(await sweepExpiredCustomerRequestLogs(now)).toEqual({ deleted: 2 });
        expect(db.requestLog.findMany).toHaveBeenCalledWith({
            where: { retention_expires_at: { lte: now } },
            select: { id: true },
            take: 5000,
            orderBy: { retention_expires_at: 'asc' },
        });
        expect(db.requestLog.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['a', 'b'] } } });
    });

    it('没有到期记录时不执行删除', async () => {
        db.requestLog.findMany.mockResolvedValue([]);
        expect(await sweepExpiredCustomerRequestLogs()).toEqual({ deleted: 0 });
        expect(db.requestLog.deleteMany).not.toHaveBeenCalled();
    });
});

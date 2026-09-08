/** 企业请求日志保留期清理单测:cutoff 计算 + 分批删除 + 空表短路。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db } = vi.hoisted(() => ({
    db: { enterpriseRequestLog: { findMany: vi.fn(), deleteMany: vi.fn() } },
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { sweepExpiredRequestLogs } from '../enterprise-reqlog-cleanup';

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ENTERPRISE_REQLOG_RETENTION_DAYS;
});

describe('sweepExpiredRequestLogs', () => {
    it('无过期行 → 不删,一次查询即返回', async () => {
        db.enterpriseRequestLog.findMany.mockResolvedValue([]);
        const r = await sweepExpiredRequestLogs();
        expect(r.deleted).toBe(0);
        expect(db.enterpriseRequestLog.deleteMany).not.toHaveBeenCalled();
    });

    it('cutoff = now - 60 天(默认),按 id 批量删', async () => {
        const now = new Date('2026-09-03T00:00:00Z');
        db.enterpriseRequestLog.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]).mockResolvedValue([]);
        db.enterpriseRequestLog.deleteMany.mockResolvedValue({ count: 2 });
        const r = await sweepExpiredRequestLogs(now);
        expect(r.deleted).toBe(2);
        const where = db.enterpriseRequestLog.findMany.mock.calls[0][0].where;
        expect(where.created_at.lt.toISOString()).toBe('2026-07-05T00:00:00.000Z');
        expect(db.enterpriseRequestLog.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['a', 'b'] } } });
    });

    it('env 覆盖保留天数', async () => {
        process.env.ENTERPRISE_REQLOG_RETENTION_DAYS = '7';
        const now = new Date('2026-09-08T00:00:00Z');
        db.enterpriseRequestLog.findMany.mockResolvedValue([]);
        await sweepExpiredRequestLogs(now);
        const where = db.enterpriseRequestLog.findMany.mock.calls[0][0].where;
        expect(where.created_at.lt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });

    it('批未满即停(不再多查一轮)', async () => {
        db.enterpriseRequestLog.findMany.mockResolvedValueOnce([{ id: 'a' }]);
        db.enterpriseRequestLog.deleteMany.mockResolvedValue({ count: 1 });
        const r = await sweepExpiredRequestLogs();
        expect(r.deleted).toBe(1);
        expect(db.enterpriseRequestLog.findMany).toHaveBeenCalledTimes(1);
    });
});

/** 企业任务对账 sweep(2026-10-19):找滞留客户 → 逐个 reconcile;单客户失败不影响其余;重入守卫。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, reconcileStaleTasks } = vi.hoisted(() => ({
    db: { seedanceVideoTask: { findMany: vi.fn() } },
    reconcileStaleTasks: vi.fn(async () => {}),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/enterprise/reconcile', () => ({ reconcileStaleTasks }));
vi.mock('@/lib/enterprise/billing', () => ({ ENTERPRISE_TIER: 'enterprise-portal' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { sweepStaleEnterpriseTasks } from '../enterprise-reconcile-sweep';

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('sweepStaleEnterpriseTasks', () => {
    it('按 user 去重查滞留任务(企业 tier、非终态、90s 前),逐个调对账器', async () => {
        db.seedanceVideoTask.findMany.mockResolvedValue([{ user_id: 'u1' }, { user_id: 'u2' }]);
        const now = new Date('2026-10-19T10:00:00Z');
        const r = await sweepStaleEnterpriseTasks(now);
        expect(r).toEqual({ users: 2 });
        expect(db.seedanceVideoTask.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    tier: 'enterprise-portal',
                    OR: [{ status: { in: ['queued', 'in_progress'] } }, { status: 'completed', billed: false }],
                    created_at: { lt: new Date('2026-10-19T09:58:30Z') },
                },
                distinct: ['user_id'],
                take: 50,
            }),
        );
        expect(reconcileStaleTasks).toHaveBeenCalledTimes(2);
        expect(reconcileStaleTasks).toHaveBeenNthCalledWith(1, 'u1');
        expect(reconcileStaleTasks).toHaveBeenNthCalledWith(2, 'u2');
    });

    it('某客户对账抛错 → 跳过继续,不抛给调度器', async () => {
        db.seedanceVideoTask.findMany.mockResolvedValue([{ user_id: 'u1' }, { user_id: 'u2' }]);
        reconcileStaleTasks.mockRejectedValueOnce(new Error('boom'));
        await expect(sweepStaleEnterpriseTasks()).resolves.toEqual({ users: 2 });
        expect(reconcileStaleTasks).toHaveBeenCalledTimes(2);
    });

    it('没有滞留任务 → 0 且不调对账器', async () => {
        db.seedanceVideoTask.findMany.mockResolvedValue([]);
        expect(await sweepStaleEnterpriseTasks()).toEqual({ users: 0 });
        expect(reconcileStaleTasks).not.toHaveBeenCalled();
    });

    it('重入守卫:上一趟没跑完时再触发 → 直接返回 0', async () => {
        let release: () => void = () => {};
        db.seedanceVideoTask.findMany.mockImplementationOnce(
            () => new Promise((res) => (release = () => res([{ user_id: 'u1' }]))),
        );
        const first = sweepStaleEnterpriseTasks();
        expect(await sweepStaleEnterpriseTasks()).toEqual({ users: 0 });
        release();
        expect(await first).toEqual({ users: 1 });
    });
});

describe('scheduler opt-in and failure recovery', () => {
    it('default does not automatically reconcile or charge existing tasks', async () => {
        const { startEnterpriseReconcileSweepScheduler, stopEnterpriseReconcileSweepScheduler } =
            await import('../enterprise-reconcile-sweep');
        vi.stubEnv('PORTAL_ENTERPRISE_RECONCILE_ENABLED', '');
        startEnterpriseReconcileSweepScheduler();
        expect(db.seedanceVideoTask.findMany).not.toHaveBeenCalled();
        stopEnterpriseReconcileSweepScheduler();
        vi.unstubAllEnvs();
    });
    it('a failed initial query releases the guard for the next scheduled run', async () => {
        db.seedanceVideoTask.findMany.mockRejectedValueOnce(new Error('temporary database outage'));
        await expect(sweepStaleEnterpriseTasks()).rejects.toThrow('temporary database outage');
        db.seedanceVideoTask.findMany.mockResolvedValueOnce([{ user_id: 'recovered-user' }]);
        expect(await sweepStaleEnterpriseTasks()).toEqual({ users: 1 });
        expect(reconcileStaleTasks).toHaveBeenCalledWith('recovered-user');
    });
});

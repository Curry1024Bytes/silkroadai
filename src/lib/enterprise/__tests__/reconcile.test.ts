/**
 * 对账器单测(2026-07-24):滞留任务 → 上游查真状态 → completed 补扣 / failed 落原因 / 过期终态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, pollVideoWithKey, pollVolcVideo, getUpstreamKeyForUser, chargeEnterpriseVideoTask } = vi.hoisted(() => ({
    db: { seedanceVideoTask: { findMany: vi.fn(), updateMany: vi.fn() } },
    pollVideoWithKey: vi.fn(),
    pollVolcVideo: vi.fn(),
    getUpstreamKeyForUser: vi.fn(),
    chargeEnterpriseVideoTask: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/seedance/cn-adapter', () => ({
    pollVideoWithKey,
    regionForModel: (m: string) =>
        m.startsWith('doubao-') ? 'volc' : m.includes('-promax') ? 'promax' : m.includes('-global') ? 'global' : 'cn',
}));
vi.mock('@/lib/seedance/kuaizi-adapter', () => ({ pollVolcVideo }));
vi.mock('../keys', () => ({ getUpstreamKeyForUser }));
vi.mock('../billing', () => ({ ENTERPRISE_TIER: 'enterprise-portal', chargeEnterpriseVideoTask }));

import { reconcileStaleTasks } from '../reconcile';

const oldDate = new Date(Date.now() - 10 * 60 * 1000); // 10min 前(过 90s 窗口)
const expiredDate = new Date(Date.now() - 50 * 60 * 60 * 1000); // 50h 前(过 48h 保留期)

beforeEach(() => {
    vi.clearAllMocks();
    db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 1 });
    getUpstreamKeyForUser.mockResolvedValue('sk-upstream');
});

describe('reconcileStaleTasks', () => {
    it('无滞留任务 → 直接返回,不查上游', async () => {
        db.seedanceVideoTask.findMany.mockResolvedValue([]);
        await reconcileStaleTasks('u1');
        expect(pollVideoWithKey).not.toHaveBeenCalled();
    });

    it('上游已 completed → 写 tokens + 幂等补扣费', async () => {
        db.seedanceVideoTask.findMany.mockResolvedValue([
            { id: 'cgt-a', model: 'seedance-2-0-promax', created_at: oldDate },
        ]);
        pollVideoWithKey.mockResolvedValue({
            ok: true,
            json: async () => ({ status: 'completed', usage: { completion_tokens: 245025 } }),
        });
        chargeEnterpriseVideoTask.mockResolvedValue({ outcome: 'charged', costCny: 30 });
        await reconcileStaleTasks('u1');
        expect(pollVideoWithKey).toHaveBeenCalledWith('cgt-a', 'Bearer sk-upstream', 'promax');
        expect(db.seedanceVideoTask.updateMany).toHaveBeenCalledWith({
            where: { id: 'cgt-a', tokens: null },
            data: { tokens: BigInt(245025), status: 'completed' },
        });
        expect(chargeEnterpriseVideoTask).toHaveBeenCalledWith('cgt-a');
    });

    it('上游 failed → 落 fail_reason,不扣费', async () => {
        db.seedanceVideoTask.findMany.mockResolvedValue([{ id: 'cgt-b', model: 'seedance-2-0', created_at: oldDate }]);
        pollVideoWithKey.mockResolvedValue({
            ok: true,
            json: async () => ({ status: 'failed', fail_reason: 'sensitive content' }),
        });
        await reconcileStaleTasks('u1');
        expect(db.seedanceVideoTask.updateMany).toHaveBeenCalledWith({
            where: { id: 'cgt-b' },
            data: { status: 'failed', fail_reason: 'sensitive content' },
        });
        expect(chargeEnterpriseVideoTask).not.toHaveBeenCalled();
    });

    it('仍在跑但未超保留期 → 不动;超 48h 上游查不到 → 过期终态', async () => {
        db.seedanceVideoTask.findMany.mockResolvedValue([
            { id: 'cgt-run', model: 'seedance-2-0', created_at: oldDate },
            { id: 'cgt-old', model: 'seedance-2-0', created_at: expiredDate },
        ]);
        pollVideoWithKey
            .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'in_progress' }) })
            .mockResolvedValueOnce({ ok: false, json: async () => null });
        await reconcileStaleTasks('u1');
        // cgt-old 过期终态(不计费)
        expect(db.seedanceVideoTask.updateMany).toHaveBeenCalledWith({
            where: { id: 'cgt-old', billed: false },
            data: { status: 'failed', fail_reason: expect.stringContaining('过期') },
        });
        expect(chargeEnterpriseVideoTask).not.toHaveBeenCalled();
    });
});

describe('火山渠道(volc)分流 —— 2026-08-18 修复', () => {
    /** volc 任务:上游是筷子开放平台 + 平台共享 env key,不是客户的 per-region key。 */
    const volcTask = { id: 'cgt-19197088188', model: 'doubao-seedance-2.5', created_at: oldDate };

    it('volc 任务走 pollVolcVideo,【不】走 cn 的 pollVideoWithKey,也不取客户 key', async () => {
        db.seedanceVideoTask.findMany.mockResolvedValue([volcTask]);
        pollVolcVideo.mockResolvedValue({ ok: true, json: async () => ({ status: 'in_progress' }) });
        await reconcileStaleTasks('u1');
        expect(pollVolcVideo).toHaveBeenCalledWith('cgt-19197088188');
        expect(pollVideoWithKey).not.toHaveBeenCalled();
        // volc 用平台 env key,不该去查客户的上游 key
        expect(getUpstreamKeyForUser).not.toHaveBeenCalled();
    });

    it('volc 任务被上游判废(4xx 终态)→ 终态化落库(修复前永远查不到、卡在 queued)', async () => {
        db.seedanceVideoTask.findMany.mockResolvedValue([volcTask]);
        pollVolcVideo.mockResolvedValue({
            ok: false,
            status: 400,
            json: async () => ({
                error: { category: 'task_type_constraint', message: 'ratio 必须为 adaptive' },
            }),
        });
        await reconcileStaleTasks('u1');
        expect(db.seedanceVideoTask.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'cgt-19197088188' },
                data: expect.objectContaining({ status: 'failed', fail_reason: 'ratio 必须为 adaptive' }),
            }),
        );
    });

    it('volc 任务上游 5xx(瞬时)→ 不落库,留给下次对账', async () => {
        db.seedanceVideoTask.findMany.mockResolvedValue([volcTask]);
        pollVolcVideo.mockResolvedValue({
            ok: false,
            status: 502,
            json: async () => ({ error: { category: 'upstream_unavailable', message: '上游暂时不可用' } }),
        });
        await reconcileStaleTasks('u1');
        expect(db.seedanceVideoTask.updateMany).not.toHaveBeenCalled();
    });

    it('volc 与 cn 任务混在一批时各走各的上游', async () => {
        db.seedanceVideoTask.findMany.mockResolvedValue([
            volcTask,
            { id: 'cgt-cn1', model: 'seedance-2-0', created_at: oldDate },
        ]);
        pollVolcVideo.mockResolvedValue({ ok: true, json: async () => ({ status: 'in_progress' }) });
        pollVideoWithKey.mockResolvedValue({ ok: true, json: async () => ({ status: 'in_progress' }) });
        await reconcileStaleTasks('u1');
        expect(pollVolcVideo).toHaveBeenCalledWith('cgt-19197088188');
        expect(pollVideoWithKey).toHaveBeenCalledWith('cgt-cn1', 'Bearer sk-upstream', 'cn');
    });
});

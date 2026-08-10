/**
 * kling 时长计费核心单测 —— 价表(官方原价)+ 幂等双账本扣费(钱敏感)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, applyLedgerEntry, syncNewapiGate, getUser, addQuota } = vi.hoisted(() => ({
    db: {
        klingVideoTask: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
        user: { findUnique: vi.fn(), update: vi.fn() },
    },
    applyLedgerEntry: vi.fn(),
    syncNewapiGate: vi.fn(),
    getUser: vi.fn(),
    addQuota: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/billing/ledger', () => ({ applyLedgerEntry }));
vi.mock('@/lib/billing/newapi-gate', () => ({ syncNewapiGate }));
vi.mock('@/lib/newapi/client', () => ({ getUser, addQuota }));
// prod-ish:1e6 quota = ¥2 → cnyToQuota(¥) = ¥ × 500000(2026-07-19 新标尺)
vi.mock('@/lib/newapi/quota-units', () => ({ cnyToQuota: (cny: number) => Math.round(cny * 500000) }));

import {
    isKlingVideoModel,
    normalizeKlingResolution,
    klingRatePerSecond,
    computeKlingCostCny,
    chargeKlingVideoTask,
} from '../billing';

describe('isKlingVideoModel', () => {
    it('4 个 kling 模型命中,其他不命中', () => {
        for (const m of ['kling-3.0-turbo', 'kling-v3', 'kling-v3-omni', 'kling-video-o1'])
            expect(isKlingVideoModel(m)).toBe(true);
        expect(isKlingVideoModel('gpt-5.5')).toBe(false);
        expect(isKlingVideoModel('seedance-2.0-720')).toBe(false);
        expect(isKlingVideoModel('')).toBe(false);
    });
});

describe('normalizeKlingResolution', () => {
    it('缺省/空 → 720p;大小写归一;标准/专业别名', () => {
        expect(normalizeKlingResolution(undefined)).toBe('720p');
        expect(normalizeKlingResolution('')).toBe('720p');
        expect(normalizeKlingResolution('1080P')).toBe('1080p');
        expect(normalizeKlingResolution('2K')).toBe('2k');
        expect(normalizeKlingResolution('4K')).toBe('4k');
        expect(normalizeKlingResolution('std')).toBe('720p');
        expect(normalizeKlingResolution('pro')).toBe('1080p');
    });
    it('未知值 → null(fail closed)', () => {
        expect(normalizeKlingResolution('8k')).toBeNull();
        expect(normalizeKlingResolution('540p')).toBeNull();
    });
});

describe('klingRatePerSecond 价表(官方原价)', () => {
    it('kling-3.0-turbo:纯按分辨率,无有声/含视频差价', () => {
        expect(klingRatePerSecond('kling-3.0-turbo', '720p', false, false)).toBe(0.8);
        expect(klingRatePerSecond('kling-3.0-turbo', '1080p', true, true)).toBe(1);
        expect(klingRatePerSecond('kling-3.0-turbo', '2k', false, false)).toBe(1.2);
        expect(klingRatePerSecond('kling-3.0-turbo', '4k', true, false)).toBe(1.44);
    });
    it('kling-v3:有声加价(¥0.6→0.9 / ¥0.8→1.2 / 4k 同价 ¥3);无 2k 档 → null', () => {
        expect(klingRatePerSecond('kling-v3', '720p', false, false)).toBe(0.6);
        expect(klingRatePerSecond('kling-v3', '720p', true, false)).toBe(0.9);
        expect(klingRatePerSecond('kling-v3', '1080p', true, false)).toBe(1.2);
        expect(klingRatePerSecond('kling-v3', '4k', true, false)).toBe(3);
        expect(klingRatePerSecond('kling-v3', '2k', false, false)).toBeNull();
    });
    it('kling-video-o1:含视频加价、无有声差价(2k ¥1.2/含视 ¥1.8;4k ¥1.8/¥2.7)', () => {
        expect(klingRatePerSecond('kling-video-o1', '2k', false, false)).toBe(1.2);
        expect(klingRatePerSecond('kling-video-o1', '2k', true, false)).toBe(1.2);
        expect(klingRatePerSecond('kling-video-o1', '2k', false, true)).toBe(1.8);
        expect(klingRatePerSecond('kling-video-o1', '4k', false, true)).toBe(2.7);
    });
    it('kling-v3-omni:全维度(2k 无声无视 ¥1 / 有声含视 ¥1.8);4k 有声取 max 防倒挂 = ¥3', () => {
        expect(klingRatePerSecond('kling-v3-omni', '2k', false, false)).toBe(1);
        expect(klingRatePerSecond('kling-v3-omni', '2k', true, true)).toBe(1.8);
        expect(klingRatePerSecond('kling-v3-omni', '720p', true, true)).toBe(1.1);
        // 上游挂牌 4k 有声 ¥2/¥2.4 低于无声 ¥3(疑标价笔误)→ 我们收 ¥3 防成本倒挂
        expect(klingRatePerSecond('kling-v3-omni', '4k', true, false)).toBe(3);
        expect(klingRatePerSecond('kling-v3-omni', '4k', true, true)).toBe(3);
    });
    it('未知模型 → null', () => {
        expect(klingRatePerSecond('kling-v9', '720p', false, false)).toBeNull();
    });
});

describe('computeKlingCostCny', () => {
    it('总价 = 单价 × 秒:v3-omni 2k 有声含视 10s = ¥18;turbo 720p 5s = ¥4', () => {
        expect(computeKlingCostCny('kling-v3-omni', '2k', true, true, 10)).toBe(18);
        expect(computeKlingCostCny('kling-3.0-turbo', '720p', false, false, 5)).toBe(4);
    });
    it('无档组合 → null', () => {
        expect(computeKlingCostCny('kling-v3', '2k', false, false, 5)).toBeNull();
    });
});

describe('chargeKlingVideoTask 幂等扣费', () => {
    const baseTask = {
        id: 't1',
        user_id: 'u1',
        newapi_user_id: 42,
        model: 'kling-v3',
        resolution: '720p',
        generate_audio: false,
        has_video: false,
        duration: 5,
        cost_cny: 3,
        billed: false,
        status: 'queued',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        db.klingVideoTask.updateMany.mockResolvedValue({ count: 1 });
        db.user.update.mockResolvedValue({});
        applyLedgerEntry.mockResolvedValue({});
        syncNewapiGate.mockResolvedValue(undefined);
        getUser.mockResolvedValue({ quota: 10_000_000 });
        addQuota.mockResolvedValue(undefined);
    });

    it('portal 账本:applyLedgerEntry charge 负数 ¥ + ref=taskId + syncNewapiGate', async () => {
        db.klingVideoTask.findUnique.mockResolvedValue({ ...baseTask });
        db.user.findUnique.mockResolvedValue({ id: 'u1', tenant_id: null, billing_mode: 'portal', newapi_user_id: 42 });
        const r = await chargeKlingVideoTask('t1');
        expect(r).toEqual({ outcome: 'charged', costCny: 3 });
        expect(applyLedgerEntry).toHaveBeenCalledWith('u1', expect.objectContaining({ amount_cny: -3, ref: 't1' }));
        expect(syncNewapiGate).toHaveBeenCalledWith('u1');
        expect(addQuota).not.toHaveBeenCalled();
    });

    it('newapi 账本:override 到 max(0, current−Δ) + 清 quota 缓存', async () => {
        db.klingVideoTask.findUnique.mockResolvedValue({ ...baseTask });
        db.user.findUnique.mockResolvedValue({ id: 'u1', tenant_id: null, billing_mode: 'newapi', newapi_user_id: 42 });
        const r = await chargeKlingVideoTask('t1');
        expect(r.outcome).toBe('charged');
        // ¥3 × 500000 = 1.5M > 当前 10M → next = 8.5M
        expect(addQuota).toHaveBeenCalledWith({ userId: 42, quotaDelta: 8_500_000, mode: 'override' });
        expect(db.user.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ newapi_quota_cache: null }) }),
        );
    });

    it('已 billed → already_billed 不重扣;CAS 抢占失败(并发)同样', async () => {
        db.klingVideoTask.findUnique.mockResolvedValue({ ...baseTask, billed: true });
        expect((await chargeKlingVideoTask('t1')).outcome).toBe('already_billed');

        db.klingVideoTask.findUnique.mockResolvedValue({ ...baseTask });
        db.klingVideoTask.updateMany.mockResolvedValue({ count: 0 });
        expect((await chargeKlingVideoTask('t1')).outcome).toBe('already_billed');
        expect(applyLedgerEntry).not.toHaveBeenCalled();
        expect(addQuota).not.toHaveBeenCalled();
    });

    it('cost_cny 缺失/0 → skipped;任务不存在 → skipped', async () => {
        db.klingVideoTask.findUnique.mockResolvedValue({ ...baseTask, cost_cny: null });
        expect((await chargeKlingVideoTask('t1')).outcome).toBe('skipped');
        db.klingVideoTask.findUnique.mockResolvedValue(null);
        expect((await chargeKlingVideoTask('nope')).outcome).toBe('skipped');
    });

    it('扣款失败 → deduct_failed,billed 不回滚(防 newapi override 双扣)', async () => {
        db.klingVideoTask.findUnique.mockResolvedValue({ ...baseTask });
        db.user.findUnique.mockResolvedValue({ id: 'u1', tenant_id: null, billing_mode: 'newapi', newapi_user_id: 42 });
        addQuota.mockRejectedValue(new Error('newapi down'));
        const r = await chargeKlingVideoTask('t1');
        expect(r.outcome).toBe('deduct_failed');
        // 没有任何把 billed 置回 false 的调用
        const rollbacks = db.klingVideoTask.updateMany.mock.calls.filter(
            (c) => (c[0]?.data as { billed?: boolean })?.billed === false,
        );
        expect(rollbacks).toHaveLength(0);
    });
});

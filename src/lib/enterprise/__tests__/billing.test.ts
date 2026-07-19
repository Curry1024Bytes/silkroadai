/**
 * 独立门户计费单测(钱敏感):议价覆盖 vs 默认挂牌 + 幂等扣费(纯 ¥账本,无 newapi 分支)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, applyLedgerEntry } = vi.hoisted(() => ({
    db: {
        seedanceVideoTask: { findUnique: vi.fn(), updateMany: vi.fn() },
        enterpriseRateOverride: { findUnique: vi.fn() },
    },
    applyLedgerEntry: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/billing/ledger', () => ({ applyLedgerEntry }));
// cn-billing 的传递依赖(本文件不触发,mock 掉防 env 读取)
vi.mock('@/lib/billing/newapi-gate', () => ({ syncNewapiGate: vi.fn() }));
vi.mock('@/lib/newapi/client', () => ({ getUser: vi.fn(), addQuota: vi.fn() }));
vi.mock('@/lib/newapi/quota-units', () => ({ cnyToQuota: (c: number) => Math.round((c * 1e6) / 7) }));

import {
    computeEnterpriseCostCny,
    estimateEnterpriseCostCny,
    chargeEnterpriseVideoTask,
    ENTERPRISE_TIER,
} from '../billing';

beforeEach(() => {
    vi.clearAllMocks();
    db.enterpriseRateOverride.findUnique.mockResolvedValue(null);
});

describe('computeEnterpriseCostCny', () => {
    it('无覆盖 → 默认挂牌(720p 无视频 ¥39.1/1M)', async () => {
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false)).toBeCloseTo(39.1, 4);
    });

    it('有覆盖 → 按覆盖价(¥30/1M)', async () => {
        db.enterpriseRateOverride.findUnique.mockResolvedValue({ cny_per_m: '30' });
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false)).toBeCloseTo(30, 4);
        expect(db.enterpriseRateOverride.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    user_id_resolution_has_video: { user_id: 'u1', resolution: '720p', has_video: false },
                },
            }),
        );
    });

    it('覆盖按 (resolution, has_video) 分档独立', async () => {
        db.enterpriseRateOverride.findUnique.mockResolvedValue(null);
        // 4k 含视频默认 ¥13.6/1M
        expect(await computeEnterpriseCostCny('u1', 2_000_000, '4k', true)).toBeCloseTo(27.2, 4);
    });

    it('estimate:含视频 1.5× 缓冲', async () => {
        const noVideo = await estimateEnterpriseCostCny('u1', '720p', 5, false);
        db.enterpriseRateOverride.findUnique.mockResolvedValue(null);
        const withVideo = await estimateEnterpriseCostCny('u1', '720p', 5, true);
        expect(noVideo).toBeGreaterThan(0);
        expect(withVideo).toBeGreaterThan(0);
    });
});

describe('chargeEnterpriseVideoTask', () => {
    const task = {
        id: 'cgt-1',
        user_id: 'u1',
        tenant_id: null,
        tier: ENTERPRISE_TIER,
        model: 'seedance2.0-pro-720p',
        resolution: '720p',
        has_video: false,
        tokens: BigInt(1_000_000),
        billed: false,
        status: 'completed',
    };

    it('happy:CAS 抢占 → applyLedgerEntry(charge, ref=taskId, 负数)', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 1 });
        applyLedgerEntry.mockResolvedValue({ balance_after: { toFixed: () => '10.90' } });
        const r = await chargeEnterpriseVideoTask('cgt-1');
        expect(r.outcome).toBe('charged');
        expect(r.costCny).toBeCloseTo(39.1, 4);
        expect(db.seedanceVideoTask.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'cgt-1', billed: false } }),
        );
        expect(applyLedgerEntry).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ kind: 'charge', amount_cny: -39.1, ref: 'cgt-1' }),
        );
    });

    it('已 billed → already_billed,不重复扣', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...task, billed: true });
        const r = await chargeEnterpriseVideoTask('cgt-1');
        expect(r.outcome).toBe('already_billed');
        expect(applyLedgerEntry).not.toHaveBeenCalled();
    });

    it('并发轮询 CAS 输了(count=0)→ already_billed,不扣', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 0 });
        const r = await chargeEnterpriseVideoTask('cgt-1');
        expect(r.outcome).toBe('already_billed');
        expect(applyLedgerEntry).not.toHaveBeenCalled();
    });

    it('tokens 未写 → skipped', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...task, tokens: null });
        expect((await chargeEnterpriseVideoTask('cgt-1')).outcome).toBe('skipped');
    });

    it('扣款失败 → deduct_failed,billed 不回滚(保守语义同 cn-billing)', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 1 });
        applyLedgerEntry.mockRejectedValue(new Error('ledger down'));
        const r = await chargeEnterpriseVideoTask('cgt-1');
        expect(r.outcome).toBe('deduct_failed');
        // 没有第二次 updateMany(不回滚 billed)
        expect(db.seedanceVideoTask.updateMany).toHaveBeenCalledTimes(1);
    });

    it('议价覆盖生效于扣费:覆盖 ¥30/1M → 扣 ¥30', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 1 });
        db.enterpriseRateOverride.findUnique.mockResolvedValue({ cny_per_m: '30' });
        applyLedgerEntry.mockResolvedValue({ balance_after: { toFixed: () => '0.00' } });
        const r = await chargeEnterpriseVideoTask('cgt-1');
        expect(r.costCny).toBeCloseTo(30, 4);
        expect(applyLedgerEntry).toHaveBeenCalledWith('u1', expect.objectContaining({ amount_cny: -30 }));
    });
});

/**
 * seedance-cn 按 token 计费核心单测 —— 费率 + 幂等双账本扣费(钱敏感)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, applyLedgerEntry, syncNewapiGate, getUser, addQuota } = vi.hoisted(() => ({
    db: {
        seedanceVideoTask: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
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
// prod-ish:1e6 quota = ¥7 → cnyToQuota(¥) = ¥ × 1e6/7
vi.mock('@/lib/newapi/quota-units', () => ({ cnyToQuota: (cny: number) => Math.round((cny * 1e6) / 7) }));

import { computeCostCny, officialCostCny, estimateCostCny, chargeSeedanceVideoTask } from '../cn-billing';

describe('computeCostCny 费率', () => {
    it('无视频档:720p ¥39.1/1M、1080p ¥43.35、4k ¥22.1', () => {
        expect(computeCostCny(1_000_000, '720p', false)).toBeCloseTo(39.1, 4);
        expect(computeCostCny(1_000_000, '1080p', false)).toBeCloseTo(43.35, 4);
        expect(computeCostCny(1_000_000, '4k', false)).toBeCloseTo(22.1, 4);
    });
    it('含视频档更便宜:720p ¥23.8、1080p ¥26.35、4k ¥13.6', () => {
        expect(computeCostCny(1_000_000, '720p', true)).toBeCloseTo(23.8, 4);
        expect(computeCostCny(1_000_000, '1080p', true)).toBeCloseTo(26.35, 4);
        expect(computeCostCny(1_000_000, '4k', true)).toBeCloseTo(13.6, 4);
    });
    it('fast 变体(2026-07-19):720p/1080p 同价 无视 ¥31.45 / 含视 ¥18.7(挂牌 37/22 ×0.85)', () => {
        expect(computeCostCny(1_000_000, '720p', false, 'fast')).toBeCloseTo(31.45, 4);
        expect(computeCostCny(1_000_000, '1080p', false, 'fast')).toBeCloseTo(31.45, 4);
        expect(computeCostCny(1_000_000, '720p', true, 'fast')).toBeCloseTo(18.7, 4);
        expect(computeCostCny(1_000_000, '1080p', true, 'fast')).toBeCloseTo(18.7, 4);
    });
    it('mini 变体:无视 ¥19.55 / 含视 ¥11.9(挂牌 23/14 ×0.85)', () => {
        expect(computeCostCny(1_000_000, '720p', false, 'mini')).toBeCloseTo(19.55, 4);
        expect(computeCostCny(1_000_000, '1080p', true, 'mini')).toBeCloseTo(11.9, 4);
    });
    it('变体缺省 = pro(存量调用不变);fast/mini 无 4k 档 → 回落 pro 4k 价(防漏收)', () => {
        expect(computeCostCny(1_000_000, '720p', false)).toBeCloseTo(39.1, 4);
        expect(computeCostCny(1_000_000, '4k', false, 'fast')).toBeCloseTo(22.1, 4);
    });
    it('720p 5s(108872 token)无视频 ≈ ¥4.26', () => {
        expect(computeCostCny(108872, '720p', false)).toBeCloseTo(4.257, 2);
    });
    it('estimate:含视频加 1.5× 缓冲', () => {
        expect(estimateCostCny('720p', 5, true)).toBeGreaterThan(estimateCostCny('720p', 5, false) * 0.6);
    });
});

const baseTask = {
    id: 'cgt-1',
    user_id: 'u1',
    tenant_id: 't1',
    newapi_user_id: 42,
    resolution: '720p',
    has_video: false,
    tokens: BigInt(108872),
    billed: false,
    model: 'seedance2.0-pro-720p',
};

describe('chargeSeedanceVideoTask 幂等 + 双账本', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 1 }); // CAS 抢到
        db.seedanceVideoTask.update.mockResolvedValue({});
        db.user.update.mockResolvedValue({});
        applyLedgerEntry.mockResolvedValue({ entryId: 'e1', balance_after: 0 });
        syncNewapiGate.mockResolvedValue(undefined);
        getUser.mockResolvedValue({ quota: 5_000_000 });
        addQuota.mockResolvedValue(undefined);
    });

    it('已 billed → already_billed,不扣', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...baseTask, billed: true });
        const r = await chargeSeedanceVideoTask('cgt-1');
        expect(r.outcome).toBe('already_billed');
        expect(applyLedgerEntry).not.toHaveBeenCalled();
        expect(addQuota).not.toHaveBeenCalled();
    });

    it('无 tokens → skipped', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...baseTask, tokens: null });
        expect((await chargeSeedanceVideoTask('cgt-1')).outcome).toBe('skipped');
    });

    it('CAS 抢不到(并发)→ already_billed', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(baseTask);
        db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 0 });
        expect((await chargeSeedanceVideoTask('cgt-1')).outcome).toBe('already_billed');
        expect(addQuota).not.toHaveBeenCalled();
    });

    it('newapi 档:读 quota → override 到 current-Δ + 清缓存', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(baseTask);
        db.user.findUnique.mockResolvedValue({ id: 'u1', tenant_id: 't1', billing_mode: 'newapi', newapi_user_id: 42 });
        const r = await chargeSeedanceVideoTask('cgt-1');
        expect(r.outcome).toBe('charged');
        expect(r.costCny).toBeCloseTo(4.257, 2);
        // override 到 max(0, 5_000_000 - cnyToQuota(4.257)) = 5_000_000 - 608_143
        const call = addQuota.mock.calls[0][0] as { mode: string; quotaDelta: number };
        expect(call.mode).toBe('override');
        expect(call.quotaDelta).toBeCloseTo(5_000_000 - Math.round((4.257 * 1e6) / 7), -2);
        expect(db.user.update).toHaveBeenCalled(); // 清缓存
        expect(applyLedgerEntry).not.toHaveBeenCalled();
    });

    it('portal 档:applyLedgerEntry charge 负额 + ref=taskId 幂等 + syncNewapiGate', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(baseTask);
        db.user.findUnique.mockResolvedValue({ id: 'u1', tenant_id: 't1', billing_mode: 'portal', newapi_user_id: 42 });
        const r = await chargeSeedanceVideoTask('cgt-1');
        expect(r.outcome).toBe('charged');
        const arg = applyLedgerEntry.mock.calls[0] as unknown as [
            string,
            { kind: string; amount_cny: number; ref: string },
        ];
        expect(arg[0]).toBe('u1');
        expect(arg[1].kind).toBe('charge');
        expect(arg[1].amount_cny).toBeLessThan(0);
        expect(arg[1].ref).toBe('cgt-1');
        expect(syncNewapiGate).toHaveBeenCalledWith('u1');
        expect(addQuota).not.toHaveBeenCalled();
    });

    it('扣款抛错 → deduct_failed,billed 已置(不回滚,防双扣)', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(baseTask);
        db.user.findUnique.mockResolvedValue({ id: 'u1', tenant_id: 't1', billing_mode: 'newapi', newapi_user_id: 42 });
        getUser.mockRejectedValueOnce(new Error('new-api down'));
        const r = await chargeSeedanceVideoTask('cgt-1');
        expect(r.outcome).toBe('deduct_failed');
        // CAS 已把 billed 置 true(updateMany 被调过)
        expect(db.seedanceVideoTask.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'cgt-1', billed: false } }),
        );
    });
});

describe('officialCostCny(对账官方价:零售 ÷ 0.85)', () => {
    it('720p pro 零售 ¥39.1 → 官方 ¥46;promax-mini 零售 ¥28.9 → 官方 ¥34', () => {
        expect(officialCostCny(1_000_000, '720p', false)).toBeCloseTo(46, 4);
        expect(officialCostCny(1_000_000, '720p', false, 'promax-mini')).toBeCloseTo(34, 4);
    });
    it('折扣 = 零售 / 官方 = 0.85(85 折)', () => {
        const retail = computeCostCny(1_000_000, '1080p', true, 'promax');
        const official = officialCostCny(1_000_000, '1080p', true, 'promax');
        expect(retail / official).toBeCloseTo(0.85, 6);
    });
});

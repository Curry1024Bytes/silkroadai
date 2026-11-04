/**
 * 独立门户计费单测(钱敏感):议价覆盖 vs 默认挂牌 + 幂等扣费(纯 ¥账本,无 newapi 分支)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, applyLedgerEntry } = vi.hoisted(() => ({
    db: {
        seedanceVideoTask: { findUnique: vi.fn(), updateMany: vi.fn() },
        enterpriseModelDiscount: { findUnique: vi.fn() },
        enterpriseUpstreamKey: { findUnique: vi.fn() },
        enterpriseGlobalDiscount: { findUnique: vi.fn() },
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
    getEnterprisePricingSnapshot,
    chargeEnterpriseVideoTask,
    ENTERPRISE_TIER,
    evaluateGlobalDiscountRule,
} from '../billing';

beforeEach(() => {
    vi.clearAllMocks();
    db.enterpriseModelDiscount.findUnique.mockResolvedValue(null); // 默认无 per-模型议价折扣
    // 新口径(2026-08-07):discount 相对【官方挂牌价】,0.85 = 标准零售(= 旧口径 discount:1)
    db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ discount: '0.85' });
    db.enterpriseGlobalDiscount.findUnique.mockResolvedValue(null); // 默认无全局折扣
});

describe('computeEnterpriseCostCny', () => {
    it('无覆盖 → 官方价 × 标准折扣 0.85(720p 无视频 46×0.85=¥39.1/1M)', async () => {
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false)).toBeCloseTo(39.1, 4);
    });

    it('per-模型议价折扣 → 官方 × 该折扣(优先级最高;pro 0.8 → 46×0.8=¥36.8),按 (user,region,variant) 查', async () => {
        db.enterpriseModelDiscount.findUnique.mockResolvedValue({ discount: '0.8' });
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false)).toBeCloseTo(36.8, 4);
        expect(db.enterpriseModelDiscount.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { user_id_region_variant: { user_id: 'u1', region: 'cn', variant: 'pro' } },
            }),
        );
    });

    it('fast/mini 变体标准价(37/23 官方 ×0.85 = ¥31.45 / ¥19.55),覆盖键按变体隔离', async () => {
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false, 'fast')).toBeCloseTo(31.45, 4);
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', true, 'fast')).toBeCloseTo(18.7, 4);
        // fast 1080p 是单独档(挂牌 40.5/24.5,2026-08-08):无视 34.425 / 含视 20.825
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '1080p', false, 'fast')).toBeCloseTo(34.425, 4);
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false, 'mini')).toBeCloseTo(19.55, 4);
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', true, 'mini')).toBeCloseTo(11.9, 4);
        // mini 1080p 单独档(挂牌 25.5/15.5,2026-08-08):含视 13.175
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '1080p', true, 'mini')).toBeCloseTo(13.175, 4);
        expect(db.enterpriseModelDiscount.findUnique).toHaveBeenLastCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    user_id_region_variant: expect.objectContaining({ variant: 'mini' }),
                }),
            }),
        );
    });

    it('客户折扣率相对官方价:0.9 → 官方 46 × 0.9 = ¥41.4(不再折上折)', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ discount: '0.9' });
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false)).toBeCloseTo(41.4, 4);
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false, 'mini')).toBeCloseTo(20.7, 4); // 23×0.9
    });

    it('per-模型议价折扣覆盖客户整体折扣(客户 0.5,议价 0.8 → 官方 46×0.8=¥36.8,不折上折)', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ discount: '0.5' });
        db.enterpriseModelDiscount.findUnique.mockResolvedValue({ discount: '0.8' });
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false)).toBeCloseTo(36.8, 4);
    });

    it('全局折扣【覆盖】客户折扣率(客户 0.85,全局 0.6 → 官方 37×0.6=¥22.2/1M,fast)', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ discount: '0.85' });
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({ discount: '0.6', expires_at: null });
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false, 'fast')).toBeCloseTo(22.2, 4);
    });

    it('全局折扣按 (region, variant) 查(隔离到目标模型)', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({ discount: '0.6', expires_at: null });
        await computeEnterpriseCostCny('u1', 1_000_000, '720p', false, 'fast', 'cn');
        expect(db.enterpriseGlobalDiscount.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { region_variant: { region: 'cn', variant: 'fast' } } }),
        );
    });

    it('全局折扣已过期(expires_at 已过)→ 失效,回落客户折扣 0.85', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({
            discount: '0.6',
            expires_at: new Date(Date.now() - 1000),
        });
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false, 'fast')).toBeCloseTo(31.45, 4); // 37×0.85
    });

    it('日历窗口按时区命中，并支持周五跨到周六', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({
            id: 'gd-calendar',
            discount: '0.9',
            expires_at: null,
            effective_from: null,
            schedule_timezone: 'Asia/Shanghai',
            schedule_weekdays: [5],
            schedule_windows: [{ start: '23:00', end: '02:00', discount: 0.6 }],
        });
        const snapshot = await getEnterprisePricingSnapshot(
            'u1',
            1_000_000,
            '720p',
            false,
            'fast',
            'cn',
            new Date('2026-11-06T17:30:00.000Z'), // 北京时间周六 01:30, 属于周五窗口
        );
        expect(snapshot.source).toBe('global');
        expect(snapshot.discount).toBe(0.6);
        expect(snapshot.costCny).toBeCloseTo(22.2, 4);
    });

    it('日历窗口支持周日跨到周一', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({
            id: 'gd-calendar',
            discount: '0.9',
            expires_at: null,
            effective_from: null,
            schedule_timezone: 'Asia/Shanghai',
            schedule_weekdays: [7],
            schedule_windows: [{ start: '23:00', end: '02:00', discount: 0.7 }],
        });
        const snapshot = await getEnterprisePricingSnapshot(
            'u1',
            1_000_000,
            '720p',
            false,
            'fast',
            'cn',
            new Date('2026-11-08T17:30:00.000Z'), // 北京时间周一 01:30, 属于周日窗口
        );
        expect(snapshot.discount).toBe(0.7);
        expect(snapshot.costCny).toBeCloseTo(25.9, 4);
    });

    it('重叠窗口按 priority 优先', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({
            id: 'gd-overlap',
            discount: '0.9',
            expires_at: null,
            effective_from: null,
            schedule_timezone: 'UTC',
            schedule_weekdays: [1],
            schedule_windows: [
                { start: '09:00', end: '12:00', discount: 0.8, priority: 10 },
                { start: '10:00', end: '11:00', discount: 0.5, priority: 1 },
            ],
        });
        const snapshot = await getEnterprisePricingSnapshot(
            'u1',
            1_000_000,
            '720p',
            false,
            'fast',
            'cn',
            new Date('2026-11-02T10:30:00.000Z'),
        );
        expect(snapshot.discount).toBe(0.8);
        expect(snapshot.rule).toEqual(expect.objectContaining({ type: 'calendar' }));
    });

    it('重叠窗口优先级相同会拒绝计费，不依赖数组顺序', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({
            id: 'gd-overlap-no-priority',
            discount: '0.9',
            expires_at: null,
            effective_from: null,
            schedule_timezone: 'UTC',
            schedule_weekdays: [1],
            schedule_windows: [
                { start: '09:00', end: '12:00', discount: 0.8 },
                { start: '10:00', end: '11:00', discount: 0.5 },
            ],
        });
        await expect(
            getEnterprisePricingSnapshot(
                'u1',
                1_000_000,
                '720p',
                false,
                'fast',
                'cn',
                new Date('2026-11-02T10:30:00.000Z'),
            ),
        ).rejects.toThrow(/overlap|ambiguous/i);
    });

    it('相邻日期的跨午夜窗口重叠时拒绝计费', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({
            id: 'gd-date-boundary-overlap',
            discount: '0.9',
            expires_at: null,
            effective_from: null,
            schedule_timezone: 'Asia/Shanghai',
            schedule_weekdays: [1, 2],
            schedule_windows: [
                {
                    start: '22:00',
                    end: '02:00',
                    discount: 0.5,
                    weekdays: [1],
                    starts_on: '2026-11-02',
                    ends_on: '2026-11-02',
                },
                {
                    start: '01:00',
                    end: '03:00',
                    discount: 0.6,
                    weekdays: [2],
                    starts_on: '2026-11-03',
                    ends_on: '2026-11-03',
                },
            ],
        });
        await expect(
            getEnterprisePricingSnapshot(
                'u1',
                1_000_000,
                '720p',
                false,
                'fast',
                'cn',
                new Date('2026-11-02T10:00:00.000Z'),
            ),
        ).rejects.toThrow(/overlap|ambiguous/i);
    });

    it('优先级明确的重叠窗口按较高优先级命中', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({
            id: 'gd-overlap-priority',
            discount: '0.9',
            expires_at: null,
            effective_from: null,
            schedule_timezone: 'UTC',
            schedule_weekdays: [1],
            schedule_windows: [
                { start: '09:00', end: '12:00', discount: 0.8, priority: 10 },
                { start: '10:00', end: '11:00', discount: 0.5, priority: 1 },
            ],
        });
        const snapshot = await getEnterprisePricingSnapshot(
            'u1',
            1_000_000,
            '720p',
            false,
            'fast',
            'cn',
            new Date('2026-11-02T10:30:00.000Z'),
        );
        expect(snapshot.discount).toBe(0.8);
    });

    it('禁用的单个日历窗口不参与促销命中', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({
            id: 'gd-disabled-window',
            discount: '0.9',
            expires_at: null,
            effective_from: null,
            schedule_timezone: 'UTC',
            schedule_weekdays: [1],
            schedule_windows: [{ start: '09:00', end: '12:00', discount: 0.5, enabled: false }],
        });
        const snapshot = await getEnterprisePricingSnapshot(
            'u1',
            1_000_000,
            '720p',
            false,
            'fast',
            'cn',
            new Date('2026-11-02T10:30:00.000Z'),
        );
        expect(snapshot.source).toBe('customer');
        expect(snapshot.discount).toBe(0.85);
    });

    it('窗口日期范围含起止日期，超出日期后不命中', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({
            id: 'gd-date-window',
            discount: '0.9',
            expires_at: null,
            effective_from: null,
            schedule_timezone: 'UTC',
            schedule_weekdays: [1, 2, 3, 4, 5, 6, 7],
            schedule_windows: [
                { start: '09:00', end: '12:00', discount: 0.5, starts_on: '2026-11-02', ends_on: '2026-11-02' },
            ],
        });
        const inside = await getEnterprisePricingSnapshot(
            'u1',
            1_000_000,
            '720p',
            false,
            'fast',
            'cn',
            new Date('2026-11-02T10:30:00.000Z'),
        );
        const outside = await getEnterprisePricingSnapshot(
            'u1',
            1_000_000,
            '720p',
            false,
            'fast',
            'cn',
            new Date('2026-11-03T10:30:00.000Z'),
        );
        expect(inside.source).toBe('global');
        expect(outside.source).toBe('customer');
    });

    it('窗口级星期覆盖整条规则星期', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({
            id: 'gd-weekday-override',
            discount: '0.9',
            expires_at: null,
            effective_from: null,
            schedule_timezone: 'UTC',
            schedule_weekdays: [1],
            schedule_windows: [{ start: '09:00', end: '12:00', discount: 0.5, weekdays: [2] }],
        });
        const snapshot = await getEnterprisePricingSnapshot(
            'u1',
            1_000_000,
            '720p',
            false,
            'fast',
            'cn',
            new Date('2026-11-03T10:30:00.000Z'),
        );
        expect(snapshot.source).toBe('global');
        expect(snapshot.discount).toBe(0.5);
    });

    it('损坏的已存日历窗口会拒绝计费，不回落到客户折扣', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({
            id: 'gd-corrupt',
            discount: '0.6',
            expires_at: null,
            effective_from: null,
            schedule_timezone: 'Asia/Shanghai',
            schedule_weekdays: [1],
            schedule_windows: [{ start: '25:00', end: '26:00', discount: 0.5 }],
        });
        await expect(
            getEnterprisePricingSnapshot(
                'u1',
                1_000_000,
                '720p',
                false,
                'fast',
                'cn',
                new Date('2026-11-02T02:00:00.000Z'),
            ),
        ).rejects.toThrow(/invalid|calendar|window/i);
    });

    it('损坏的日历时区会拒绝计费，不回落到客户折扣', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({
            id: 'gd-invalid-timezone',
            discount: '0.6',
            expires_at: null,
            effective_from: null,
            schedule_timezone: 'Not/AZone',
            schedule_weekdays: [1],
            schedule_windows: [{ start: '09:00', end: '10:00', discount: 0.5 }],
        });
        await expect(
            getEnterprisePricingSnapshot(
                'u1',
                1_000_000,
                '720p',
                false,
                'fast',
                'cn',
                new Date('2026-11-02T02:00:00.000Z'),
            ),
        ).rejects.toThrow(/invalid|timezone|calendar/i);
    });

    it('未知定价身份会拒绝计费，不猜测默认档次', async () => {
        await expect(
            getEnterprisePricingSnapshot('u1', 1_000_000, '720p', false, 'unknown-variant' as never, 'cn'),
        ).rejects.toThrow(/unknown|invalid|pricing|variant/i);
        await expect(
            getEnterprisePricingSnapshot('u1', 1_000_000, '720p', false, 'pro', 'unknown-region' as never),
        ).rejects.toThrow(/unknown|invalid|pricing|region/i);
        expect(db.enterpriseModelDiscount.findUnique).not.toHaveBeenCalled();
        expect(db.enterpriseGlobalDiscount.findUnique).not.toHaveBeenCalled();
    });

    it('有效期未开始或窗口未命中时回落客户折扣', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({
            id: 'gd-calendar',
            discount: '0.6',
            expires_at: null,
            effective_from: new Date('2026-11-03T00:00:00.000Z'),
            schedule_timezone: 'UTC',
            schedule_weekdays: [1],
            schedule_windows: [{ start: '09:00', end: '10:00', discount: 0.5 }],
        });
        const before = await getEnterprisePricingSnapshot(
            'u1',
            1_000_000,
            '720p',
            false,
            'fast',
            'cn',
            new Date('2026-11-02T10:00:00.000Z'),
        );
        expect(before.source).toBe('customer');
        const outside = await getEnterprisePricingSnapshot(
            'u1',
            1_000_000,
            '720p',
            false,
            'fast',
            'cn',
            new Date('2026-11-03T12:00:00.000Z'),
        );
        expect(outside.source).toBe('customer');
    });

    it('per-模型议价折扣 > 全局折扣(议价 0.8 + 全局 0.6 → 官方 37×0.8=¥29.6,fast,议价胜)', async () => {
        db.enterpriseModelDiscount.findUnique.mockResolvedValue({ discount: '0.8' });
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({ discount: '0.6', expires_at: null });
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false, 'fast')).toBeCloseTo(29.6, 4);
    });

    it('无 upstream key 行使用官方价，已存非法客户折扣拒绝报价', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue(null);
        // 没有客户折扣行时按模型默认售价计费。
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false)).toBeCloseTo(46, 4);
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ discount: '0' });
        await expect(computeEnterpriseCostCny('u1', 1_000_000, '720p', false)).rejects.toThrow(
            /invalid.*customer.*discount/i,
        );
    });

    it('已存客户模型折扣倍率非法时拒绝报价，不回落到更低的全局折扣', async () => {
        db.enterpriseModelDiscount.findUnique.mockResolvedValue({ discount: '0.001' });
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({ discount: '0.5', expires_at: null });
        await expect(computeEnterpriseCostCny('u1', 1_000_000, '720p', false, 'fast', 'cn')).rejects.toThrow(
            /invalid.*model.*discount/i,
        );
        expect(db.enterpriseUpstreamKey.findUnique).not.toHaveBeenCalled();
    });

    it('global 版本:折扣/覆盖按 region 行查(user_id_region),挂牌价同国内', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ discount: '0.8' });
        // 官方 mini 23 × 0.8 = 18.4(旧口径为 19.55×0.8=15.64,折上折)
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false, 'mini', 'global')).toBeCloseTo(18.4, 4);
        expect(db.enterpriseUpstreamKey.findUnique).toHaveBeenLastCalledWith(
            expect.objectContaining({ where: { user_id_region: { user_id: 'u1', region: 'global' } } }),
        );
        expect(db.enterpriseModelDiscount.findUnique).toHaveBeenLastCalledWith(
            expect.objectContaining({
                where: { user_id_region_variant: expect.objectContaining({ region: 'global' }) },
            }),
        );
    });

    it('global 短名任务扣费:variant + region 都从 task.model 推导', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({
            id: 'cgt-g1',
            user_id: 'u1',
            tenant_id: null,
            tier: ENTERPRISE_TIER,
            model: 'seedance-2-0-global-mini',
            resolution: '720p',
            has_video: false,
            tokens: BigInt(1_000_000),
            billed: false,
            status: 'completed',
        });
        db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 1 });
        applyLedgerEntry.mockResolvedValue({ balance_after: { toFixed: () => '0.00' } });
        const r = await chargeEnterpriseVideoTask('cgt-g1');
        expect(r.costCny).toBeCloseTo(19.55, 4);
        expect(db.enterpriseUpstreamKey.findUnique).toHaveBeenLastCalledWith(
            expect.objectContaining({ where: { user_id_region: { user_id: 'u1', region: 'global' } } }),
        );
    });

    it('promax 系标准价(官方×0.85):mini 28.9 / fast 46.24 / pro 4k 32.368;含视 17.34', async () => {
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false, 'promax-mini', 'promax')).toBeCloseTo(
            28.9,
            4,
        );
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', false, 'promax-fast', 'promax')).toBeCloseTo(
            46.24,
            4,
        );
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '4k', false, 'promax', 'promax')).toBeCloseTo(32.368, 4);
        expect(await computeEnterpriseCostCny('u1', 1_000_000, '720p', true, 'promax-mini', 'promax')).toBeCloseTo(
            17.34,
            4,
        );
    });

    it('promax 短名任务扣费:variant=promax-mini + region=promax 全从 task.model 推导', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({
            id: 'cgt-pm1',
            user_id: 'u1',
            tenant_id: null,
            tier: ENTERPRISE_TIER,
            model: 'seedance-2-0-promax-mini',
            resolution: '720p',
            has_video: false,
            tokens: BigInt(1_000_000),
            billed: false,
            status: 'completed',
        });
        db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 1 });
        applyLedgerEntry.mockResolvedValue({ balance_after: { toFixed: () => '0.00' } });
        const r = await chargeEnterpriseVideoTask('cgt-pm1');
        expect(r.costCny).toBeCloseTo(28.9, 4);
        expect(db.enterpriseUpstreamKey.findUnique).toHaveBeenLastCalledWith(
            expect.objectContaining({ where: { user_id_region: { user_id: 'u1', region: 'promax' } } }),
        );
    });

    it('归一短名任务(seedance-2-0-mini)扣费按 mini 费率(variantForModel 后缀识别)', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({
            id: 'cgt-s1',
            user_id: 'u1',
            tenant_id: null,
            tier: ENTERPRISE_TIER,
            model: 'seedance-2-0-mini',
            resolution: '720p',
            has_video: false,
            tokens: BigInt(1_000_000),
            billed: false,
            status: 'completed',
        });
        db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 1 });
        applyLedgerEntry.mockResolvedValue({ balance_after: { toFixed: () => '0.00' } });
        const r = await chargeEnterpriseVideoTask('cgt-s1');
        expect(r.costCny).toBeCloseTo(19.55, 4);
    });

    it('fast 任务扣费按 fast 费率(variant 从 task.model 推导)', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({
            id: 'cgt-f1',
            user_id: 'u1',
            tenant_id: null,
            tier: ENTERPRISE_TIER,
            model: 'seedance2.0-fast-720p',
            resolution: '720p',
            has_video: false,
            tokens: BigInt(1_000_000),
            billed: false,
            status: 'completed',
        });
        db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 1 });
        applyLedgerEntry.mockResolvedValue({ balance_after: { toFixed: () => '0.00' } });
        const r = await chargeEnterpriseVideoTask('cgt-f1');
        expect(r.costCny).toBeCloseTo(31.45, 4);
    });

    it('无议价折扣 → 官方 4k 含视 × 0.85(pro 4k 含视 16 × 0.85 = 13.6/1M)', async () => {
        db.enterpriseModelDiscount.findUnique.mockResolvedValue(null);
        expect(await computeEnterpriseCostCny('u1', 2_000_000, '4k', true)).toBeCloseTo(27.2, 4);
    });

    it('estimate:含视频 1.5× 缓冲', async () => {
        const noVideo = await estimateEnterpriseCostCny('u1', '720p', 5, false);
        db.enterpriseModelDiscount.findUnique.mockResolvedValue(null);
        const withVideo = await estimateEnterpriseCostCny('u1', '720p', 5, true);
        expect(noVideo).toBeGreaterThan(0);
        expect(withVideo).toBeGreaterThan(0);
    });
});

describe('evaluateGlobalDiscountRule', () => {
    const calendarRule = {
        discount: 0.9,
        expires_at: null,
        effective_from: null,
        schedule_timezone: 'Asia/Shanghai',
        schedule_weekdays: [3],
        schedule_windows: [{ start: '09:00', end: '10:00', discount: 0.6 }],
    };

    it('returns the next calendar start as a UTC ISO timestamp when inactive', () => {
        const status = evaluateGlobalDiscountRule(calendarRule, new Date('2026-11-04T00:30:00.000Z'));

        expect(status).toMatchObject({ active: false, status: 'inactive' });
        expect(status.next_transition_at).toBe('2026-11-04T01:00:00.000Z');
        expect(status.next_transition_kind).toBe('start');
    });

    it('returns the next calendar end as a UTC ISO timestamp when active', () => {
        const status = evaluateGlobalDiscountRule(calendarRule, new Date('2026-11-04T01:30:00.000Z'));

        expect(status).toMatchObject({ active: true, status: 'active', discount: 0.6 });
        expect(status.next_transition_at).toBe('2026-11-04T02:00:00.000Z');
        expect(status.next_transition_kind).toBe('end');
    });

    it('rejects malformed stored windows and active equal-priority overlaps', () => {
        expect(() =>
            evaluateGlobalDiscountRule(
                { ...calendarRule, schedule_windows: [{ start: '25:00', end: '26:00', discount: 0.6 }] },
                new Date('2026-11-04T00:00:00.000Z'),
            ),
        ).toThrow(/invalid|calendar|window/i);

        expect(() =>
            evaluateGlobalDiscountRule(
                {
                    ...calendarRule,
                    schedule_windows: [
                        { start: '09:00', end: '11:00', discount: 0.6, priority: 1 },
                        { start: '10:00', end: '12:00', discount: 0.5, priority: 1 },
                    ],
                },
                new Date('2026-11-04T01:30:00.000Z'),
            ),
        ).toThrow(/ambiguous|overlapping/i);
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

    const frozenRule = {
        type: 'customer',
        source: 'customer',
        timezone: 'Asia/Shanghai',
        identity: {
            family: 'seedance',
            region: 'cn',
            variant: 'pro',
            resolution: '720p',
            hasVideo: false,
        },
        basis: { currency: 'CNY', unit: 'token', unitQuantity: 1_000_000, rate: 100 },
        evaluatedAt: '2026-11-04T00:00:00.000Z',
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

    it('扣款失败 → deduct_failed并释放 claim，后续可重试且由账本幂等去重', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        db.seedanceVideoTask.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
        applyLedgerEntry.mockRejectedValue(new Error('ledger down'));
        const r = await chargeEnterpriseVideoTask('cgt-1');
        expect(r.outcome).toBe('deduct_failed');
        const release = db.seedanceVideoTask.updateMany.mock.calls[1][0];
        expect(release).toMatchObject({
            where: { id: 'cgt-1', billed: true, cost_cny: 39.1, billed_at: expect.any(Date) },
            data: { billed: false },
        });
    });

    it('per-模型议价折扣生效于扣费:pro 议价 0.8 → 官方 46×0.8=扣 ¥36.8', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 1 });
        db.enterpriseModelDiscount.findUnique.mockResolvedValue({ discount: '0.8' });
        applyLedgerEntry.mockResolvedValue({ balance_after: { toFixed: () => '0.00' } });
        const r = await chargeEnterpriseVideoTask('cgt-1');
        expect(r.costCny).toBeCloseTo(36.8, 4);
        expect(applyLedgerEntry).toHaveBeenCalledWith('u1', expect.objectContaining({ amount_cny: -36.8 }));
    });

    it('结算使用任务保存的费率快照，不读取完成时实时费率', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({
            ...task,
            pricing_discount: '0.6',
            pricing_source: 'customer',
            pricing_rule: frozenRule,
            pricing_timezone: 'Asia/Shanghai',
        });
        db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 1 });
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({ discount: '0.9', expires_at: null });
        applyLedgerEntry.mockResolvedValue({ balance_after: { toFixed: () => '0.00' } });
        const r = await chargeEnterpriseVideoTask('cgt-1');
        expect(r.costCny).toBeCloseTo(60, 4);
        expect(db.enterpriseGlobalDiscount.findUnique).not.toHaveBeenCalled();
    });

    it.each([
        ['缺失规则', { pricing_rule: null }],
        ['缺失来源', { pricing_source: null }],
        ['缺失时区', { pricing_timezone: null }],
        ['损坏的折扣', { pricing_discount: 'not-a-rate' }],
        ['未知来源', { pricing_source: 'unknown' }],
        ['source 与 rule 不匹配', { pricing_rule: { ...frozenRule, source: 'global' } }],
        ['规则时区与任务时区不匹配', { pricing_timezone: 'UTC' }],
        ['无效 UTC 评估时间', { pricing_rule: { ...frozenRule, evaluatedAt: 'not-a-date' } }],
        ['损坏的单位费率', { pricing_rule: { ...frozenRule, basis: { ...frozenRule.basis, rate: 'not-a-rate' } } }],
        [
            '身份与任务不匹配',
            { pricing_rule: { ...frozenRule, identity: { ...frozenRule.identity, variant: 'mini' } } },
        ],
    ])('新任务快照%s时在 CAS 前拒绝结算', async (_label, overrides) => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({
            ...task,
            pricing_discount: '0.6',
            pricing_source: 'customer',
            pricing_rule: frozenRule,
            pricing_timezone: 'Asia/Shanghai',
            ...overrides,
        });
        await expect(chargeEnterpriseVideoTask('cgt-1')).rejects.toThrow(/pricing|snapshot|identity|invalid/i);
        expect(db.seedanceVideoTask.updateMany).not.toHaveBeenCalled();
        expect(applyLedgerEntry).not.toHaveBeenCalled();
    });

    it('未知模型名在 CAS 前拒绝结算', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...task, model: 'unknown-model' });
        await expect(chargeEnterpriseVideoTask('cgt-1')).rejects.toThrow(/unknown|invalid|model|pricing/i);
        expect(db.seedanceVideoTask.updateMany).not.toHaveBeenCalled();
        expect(applyLedgerEntry).not.toHaveBeenCalled();
    });
});

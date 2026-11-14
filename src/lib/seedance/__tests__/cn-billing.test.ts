/**
 * seedance-cn 按 token 计费核心单测 —— 费率 + 幂等双账本扣费(钱敏感)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, applyLedgerEntry, syncNewapiGate, getUser, addQuota, getOption } = vi.hoisted(() => ({
    db: {
        $transaction: vi.fn(),
        $executeRaw: vi.fn(),
        $queryRaw: vi.fn(),
        seedanceVideoTask: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
        user: { findUnique: vi.fn(), update: vi.fn() },
        catalogModel: { findMany: vi.fn() },
        channelGroup: { findMany: vi.fn() },
        catalogPrice: { findFirst: vi.fn() },
        userTierMultiplier: { findMany: vi.fn() },
    },
    applyLedgerEntry: vi.fn(),
    syncNewapiGate: vi.fn(),
    getUser: vi.fn(),
    addQuota: vi.fn(),
    getOption: vi.fn(),
}));
db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) => callback(db));
db.$executeRaw.mockResolvedValue(0);
db.$queryRaw.mockResolvedValue([{ id: 'newapi' }]);
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/billing/ledger', () => ({ applyLedgerEntry }));
vi.mock('@/lib/billing/newapi-gate', () => ({ syncNewapiGate }));
vi.mock('@/lib/newapi/client', () => ({ getUser, addQuota, getOption }));
// prod-ish:1e6 quota = ¥7 → cnyToQuota(¥) = ¥ × 1e6/7
vi.mock('@/lib/newapi/quota-units', () => ({
    USD_TO_CNY_RATE: 1,
    QUOTA_PER_USD: 500_000,
    cnyToQuota: (cny: number) => Math.round((cny * 1e6) / 7),
}));

import {
    computeCostCny,
    officialCostCny,
    estimateCostCny,
    chargeSeedanceVideoTask,
    getSeedancePricingSnapshot,
    snapshotCostCny,
} from '../cn-billing';
import { VIDEO_TOKEN_COMBOS } from '@/lib/admin/pricing-video-token-expression';
import { variantForModel } from '../cn-adapter';

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
    it('fast 变体:720p 无视 ¥31.45/含视 ¥18.7(挂牌 37/22);1080p 单独档 无视 ¥34.425/含视 ¥20.825(挂牌 40.5/24.5 ×0.85,2026-08-08)', () => {
        expect(computeCostCny(1_000_000, '720p', false, 'fast')).toBeCloseTo(31.45, 4);
        expect(computeCostCny(1_000_000, '1080p', false, 'fast')).toBeCloseTo(34.425, 4);
        expect(computeCostCny(1_000_000, '720p', true, 'fast')).toBeCloseTo(18.7, 4);
        expect(computeCostCny(1_000_000, '1080p', true, 'fast')).toBeCloseTo(20.825, 4);
    });
    it('mini 变体:720p 无视 ¥19.55/含视 ¥11.9(挂牌 23/14);1080p 单独档 无视 ¥21.675/含视 ¥13.175(挂牌 25.5/15.5 ×0.85,2026-08-08)', () => {
        expect(computeCostCny(1_000_000, '720p', false, 'mini')).toBeCloseTo(19.55, 4);
        expect(computeCostCny(1_000_000, '720p', true, 'mini')).toBeCloseTo(11.9, 4);
        expect(computeCostCny(1_000_000, '1080p', false, 'mini')).toBeCloseTo(21.675, 4);
        expect(computeCostCny(1_000_000, '1080p', true, 'mini')).toBeCloseTo(13.175, 4);
    });
    it('变体缺省 = pro(存量调用不变);fast/mini 无 4k 档 → 回落 pro 4k 价(防漏收)', () => {
        expect(computeCostCny(1_000_000, '720p', false)).toBeCloseTo(39.1, 4);
        expect(computeCostCny(1_000_000, '4k', false, 'fast')).toBeCloseTo(22.1, 4);
    });
    it('720p 5s(108872 token)无视频 ≈ ¥4.26', () => {
        expect(computeCostCny(108872, '720p', false)).toBeCloseTo(4.257, 2);
    });
    it('480p(2026-08-03 volc 开放):与 720p 同费率 无视 ¥39.1 / 含视 ¥23.8;5s(50638 token)≈ ¥1.98', () => {
        expect(computeCostCny(1_000_000, '480p', false)).toBeCloseTo(39.1, 4);
        expect(computeCostCny(1_000_000, '480p', true)).toBeCloseTo(23.8, 4);
        expect(computeCostCny(50638, '480p', false)).toBeCloseTo(1.98, 2);
    });
    it('480p 预估锚点:10128 token/秒(实测 5s=50638)', () => {
        expect(estimateCostCny('480p', 5, false)).toBeCloseTo((10128 * 5 * 39.1) / 1e6, 4);
    });
    it('480p 全变体开放(2026-08-03):各变体 480p = 各自 720p 同费率', () => {
        expect(computeCostCny(1_000_000, '480p', false, 'fast')).toBeCloseTo(31.45, 4);
        expect(computeCostCny(1_000_000, '480p', true, 'fast')).toBeCloseTo(18.7, 4);
        expect(computeCostCny(1_000_000, '480p', false, 'mini')).toBeCloseTo(19.55, 4);
        expect(computeCostCny(1_000_000, '480p', true, 'mini')).toBeCloseTo(11.9, 4);
        expect(computeCostCny(1_000_000, '480p', false, 'promax')).toBeCloseTo(57.8, 4);
        expect(computeCostCny(1_000_000, '480p', true, 'promax')).toBeCloseTo(34.68, 4);
        expect(computeCostCny(1_000_000, '480p', false, 'promax-fast')).toBeCloseTo(46.24, 4);
        expect(computeCostCny(1_000_000, '480p', false, 'promax-mini')).toBeCloseTo(28.9, 4);
        // promax-2.5 480p(2026-10-15 随 svcinf dreamina 上游重开)= 720p 同费率 72.76/43.52 × 0.85
        expect(computeCostCny(1_000_000, '480p', false, 'promax-2.5')).toBeCloseTo(72.76 * 0.85, 4);
        expect(computeCostCny(1_000_000, '480p', true, 'promax-2.5')).toBeCloseTo(43.52 * 0.85, 4);
    });
    it('estimate:含视频加 1.5× 缓冲', () => {
        expect(estimateCostCny('720p', 5, true)).toBeGreaterThan(estimateCostCny('720p', 5, false) * 0.6);
    });
});

describe('Seedance live pricing snapshot', () => {
    const catalogDetails = {
        version: 1 as const,
        mode: 'video_token' as const,
        unit: 'cny_per_million_tokens' as const,
        cells: VIDEO_TOKEN_COMBOS.map((combo) => ({
            ...combo,
            price: combo.resolution === '720p' && combo.video_input === 'none' ? 75 : 50,
        })),
    };

    beforeEach(() => {
        db.catalogModel.findMany.mockResolvedValue([
            {
                id: 'model-1',
                slug: 'seedance2.5-720p',
                upstream_map: {
                    'seedance-cn-enterprise': { channel_id: 7, upstream_model: 'seedance-upstream' },
                },
            },
        ]);
        db.channelGroup.findMany.mockResolvedValue([
            {
                key: 'seedance-cn-enterprise',
                newapi_group: 'enterprise',
                newapi_channel_ids: [7],
                is_default: true,
                enabled: true,
                tier_level: 0,
            },
        ]);
        db.catalogPrice.findFirst.mockResolvedValue({
            id: 'catalog-price-1',
            effective_from: new Date('2026-11-13T00:00:00.000Z'),
            billing_details: catalogDetails,
        });
        db.userTierMultiplier.findMany.mockResolvedValue([]);
        getOption.mockResolvedValue(JSON.stringify({ enterprise: 1 }));
    });

    it('freezes the live rounded actual quote and avoids applying the discount twice', async () => {
        const readOrder: string[] = [];
        db.$executeRaw.mockImplementation(async () => {
            readOrder.push('coordinator-row-ready');
            return 1;
        });
        db.$queryRaw.mockImplementation(async () => {
            readOrder.push('coordinator-row-locked');
            return [{ id: 'newapi' }];
        });
        db.catalogModel.findMany.mockImplementation(async () => {
            readOrder.push('catalog-model');
            return [
                {
                    id: 'model-1',
                    slug: 'seedance2.5-720p',
                    upstream_map: {
                        'seedance-cn-enterprise': { channel_id: 7, upstream_model: 'seedance-upstream' },
                    },
                },
            ];
        });
        db.channelGroup.findMany.mockImplementation(async () => {
            readOrder.push('channel-group');
            return [
                {
                    key: 'seedance-cn-enterprise',
                    newapi_group: 'enterprise',
                    newapi_channel_ids: [7],
                    is_default: true,
                    enabled: true,
                    tier_level: 0,
                },
            ];
        });
        db.catalogPrice.findFirst.mockImplementation(async () => {
            readOrder.push('catalog-price');
            return {
                id: 'catalog-price-1',
                effective_from: new Date('2026-11-13T00:00:00.000Z'),
                billing_details: catalogDetails,
            };
        });

        const snapshot = await getSeedancePricingSnapshot('seedance2.5-720p', 'seedance-cn-enterprise', '720p', false);
        expect(snapshot.rate).toBe(75);
        expect(snapshot.discount).toBe(1);
        expect(snapshot.rule).toMatchObject({
            basis: { rate: 75 },
            catalog_price_id: 'catalog-price-1',
            identity: {
                model: 'seedance2.5-720p',
                tier: 'seedance-cn-enterprise',
                resolution: '720p',
                hasVideo: false,
            },
        });
        expect(snapshotCostCny(1_000_000, snapshot)).toBe(75);
        expect(readOrder.slice(0, 2)).toEqual(['coordinator-row-ready', 'coordinator-row-locked']);
        expect(readOrder.slice(2)).toEqual(expect.arrayContaining(['catalog-model', 'channel-group', 'catalog-price']));
        expect(
            readOrder.slice(2).every((read) => readOrder.indexOf('coordinator-row-locked') < readOrder.indexOf(read)),
        ).toBe(true);
    });

    it('rejects a missing CatalogPrice instead of falling back to cost rules or official rates', async () => {
        db.catalogPrice.findFirst.mockResolvedValue(null);
        await expect(
            getSeedancePricingSnapshot('seedance2.5-720p', 'seedance-cn-enterprise', '720p', false),
        ).rejects.toThrow(/catalog price unavailable/i);
    });

    it('rejects incomplete or malformed CatalogPrice video cells', async () => {
        db.catalogPrice.findFirst.mockResolvedValue({
            id: 'catalog-price-bad',
            effective_from: new Date('2026-11-13T00:00:00.000Z'),
            billing_details: { ...catalogDetails, cells: catalogDetails.cells.slice(0, 7) },
        });
        await expect(
            getSeedancePricingSnapshot('seedance2.5-720p', 'seedance-cn-enterprise', '720p', false),
        ).rejects.toThrow(/video-token catalog price is incomplete/i);
    });

    it('rejects scheduled discounts until Seedance submission and settlement can apply them consistently', async () => {
        db.catalogPrice.findFirst.mockResolvedValue({
            id: 'catalog-price-scheduled',
            effective_from: new Date('2026-11-13T00:00:00.000Z'),
            billing_details: {
                ...catalogDetails,
                scheduled_discount: {
                    start: '00:00',
                    end: '08:00',
                    timezone: 'Asia/Shanghai',
                    multiplier: 0.75,
                },
            },
        });
        await expect(
            getSeedancePricingSnapshot('seedance2.5-720p', 'seedance-cn-enterprise', '720p', false),
        ).rejects.toThrow(/unsupported scheduled pricing/i);
    });

    it('rejects a broken active channel-group topology instead of pricing through it', async () => {
        db.channelGroup.findMany.mockResolvedValue([
            {
                key: 'seedance-cn-enterprise',
                newapi_group: 'enterprise',
                newapi_channel_ids: [],
                is_default: true,
                enabled: true,
                tier_level: 0,
            },
        ]);
        await expect(
            getSeedancePricingSnapshot('seedance2.5-720p', 'seedance-cn-enterprise', '720p', false),
        ).rejects.toThrow(/invalid channel-group topology/i);
    });

    it('applies the signed-in customer multiplier once relative to public GroupRatio', async () => {
        db.userTierMultiplier.findMany.mockResolvedValue([{ newapi_billing_group: 'enterprise', multiplier: 0.75 }]);
        getOption.mockResolvedValue(JSON.stringify({ enterprise: 1 }));

        const snapshot = await getSeedancePricingSnapshot(
            'seedance2.5-720p',
            'seedance-cn-enterprise',
            '720p',
            false,
            null,
            'customer-1',
        );

        expect(snapshot.rate).toBe(56.25);
        expect(snapshot.rule).toMatchObject({
            public_rate: 75,
            customer_multiplier: 0.75,
            public_group_ratio: 1,
            customer_scale: 0.75,
        });
        expect(db.userTierMultiplier.findMany).toHaveBeenCalledWith({
            where: { user_id: 'customer-1', tier_key: 'seedance-cn-enterprise', enabled: true },
            select: { newapi_billing_group: true, multiplier: true },
        });
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

const frozenTask = {
    ...baseTask,
    tier: 'seedance-cn-enterprise',
    pricing_discount: 1,
    pricing_source: 'model',
    pricing_timezone: 'Asia/Shanghai',
    pricing_rule: {
        type: 'model',
        source: 'model',
        timezone: 'Asia/Shanghai',
        identity: { model: baseTask.model, tier: 'seedance-cn-enterprise', resolution: '720p', hasVideo: false },
        basis: { currency: 'CNY', unit: 'token', unitQuantity: 1_000_000, rate: 75.024 },
        evaluatedAt: '2026-11-13T00:00:00.000Z',
    },
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

    it('new task uses the persisted live quote snapshot instead of static official rates', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(frozenTask);
        db.user.findUnique.mockResolvedValue({ id: 'u1', tenant_id: 't1', billing_mode: 'portal', newapi_user_id: 42 });
        const r = await chargeSeedanceVideoTask('cgt-1');
        expect(r.outcome).toBe('charged');
        expect(r.costCny).toBeCloseTo((108872 / 1_000_000) * 75.024, 6);
        expect(applyLedgerEntry.mock.calls[0][1]).toMatchObject({ amount_cny: -r.costCny! });
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

    // 2026-08-31 海外版 global 2.5:与 promax-2.5 同价(单一价源)。若这两行断言失败,
    // 说明有人把 global 2.5 落到了 cn 2.5 档(70/90)—— 那是错价。
    it('seedance-2-5-global 按 promax-2.5 费率计费,不是 cn 2.5', () => {
        expect(variantForModel('seedance-2-5-global')).toBe('promax-2.5');
        expect(officialCostCny(1_000_000, '720p', false, 'promax-2.5')).toBeCloseTo(72.76, 4);
        expect(officialCostCny(1_000_000, '1080p', false, 'promax-2.5')).toBeCloseTo(80.24, 4);
    });
});

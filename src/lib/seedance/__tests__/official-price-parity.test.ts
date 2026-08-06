/**
 * 文档挂牌价口径守护(2026-08-07,operator:文档应印【官方原价】而非 85 折零售价)。
 *
 * 企业门户 /enterprise/docs 的价目表由 officialCostCny() 推导(不再硬编码),
 * 本测试锁住推导结果 = 727/火山官方挂牌价,防调价时文档与账单三列口径漂移。
 * 账单口径:官方价(本表)× 客户折扣率 = 实付;默认折扣 8.5 折 = computeCostCny。
 */
import { describe, expect, it } from 'vitest';
import { computeCostCny, officialCostCny, RETAIL_RATIO } from '../cn-billing';
import type { SeedanceVariant } from '../cn-adapter';

/** 官方挂牌价(¥/1M token):[变体][分辨率] = [无视频, 含视频]。来源 = 费率表注释里的挂牌值。 */
const OFFICIAL: Array<[SeedanceVariant, string, number, number]> = [
    ['pro', '480p', 46, 28],
    ['pro', '720p', 46, 28],
    ['pro', '1080p', 51, 31],
    ['pro', '4k', 26, 16],
    ['fast', '720p', 37, 22],
    ['mini', '720p', 23, 14],
    ['promax', '720p', 68, 40.8],
    ['promax', '1080p', 73.44, 44.88],
    ['promax', '4k', 38.08, 23.12],
    ['promax-fast', '720p', 54.4, 32.896],
    ['promax-mini', '720p', 34, 20.4],
];

describe('官方挂牌价 = 文档价目表口径', () => {
    it.each(OFFICIAL)('%s %s → 官方价 无视频 ¥%s / 含视频 ¥%s', (variant, res, noVideo, withVideo) => {
        expect(officialCostCny(1_000_000, res as never, false, variant)).toBeCloseTo(noVideo, 3);
        expect(officialCostCny(1_000_000, res as never, true, variant)).toBeCloseTo(withVideo, 3);
    });

    it('实付 = 官方价 × 8.5 折(默认无客户折扣时,与 computeCostCny 一致)', () => {
        for (const [variant, res, noVideo] of OFFICIAL) {
            expect(computeCostCny(1_000_000, res as never, false, variant)).toBeCloseTo(noVideo * 0.85, 3);
        }
    });

    it('口径守护:seedance-cn 零售 = 官方 × RETAIL_RATIO;企业门户折扣直乘官方(不得折上折)', () => {
        expect(RETAIL_RATIO).toBe(0.85);
        // computeCostCny 只做零售一次折扣;若谁把 0.85 又烘焙回表里,本断言会红
        expect(computeCostCny(1_000_000, '720p' as never, false, 'pro')).toBeCloseTo(46 * RETAIL_RATIO, 4);
        expect(officialCostCny(1_000_000, '720p' as never, false, 'pro')).toBeCloseTo(46, 4);
        // 企业门户口径:官方 × discount。0.85 = 标准零售(与 cn 渠道同价),0.9 = 官方九折
        expect(officialCostCny(1_000_000, '720p' as never, false, 'pro') * 0.85).toBeCloseTo(39.1, 4);
        expect(officialCostCny(1_000_000, '720p' as never, false, 'pro') * 0.9).toBeCloseTo(41.4, 4);
    });

    it('480p 与 720p 官方价同价(全变体)', () => {
        for (const v of ['pro', 'fast', 'mini', 'promax', 'promax-fast', 'promax-mini'] as SeedanceVariant[]) {
            expect(officialCostCny(1_000_000, '480p' as never, false, v)).toBeCloseTo(
                officialCostCny(1_000_000, '720p' as never, false, v),
                3,
            );
        }
    });
});

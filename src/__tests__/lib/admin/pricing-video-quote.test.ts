import { describe, expect, it } from 'vitest';
import {
    computeVideoQuote,
    videoQuoteCostConfig,
    videoQuoteFromCostConfig,
    type VideoQuoteInput,
} from '@/lib/admin/pricing-video-quote';
import { VIDEO_TOKEN_COMBOS, videoTokenKey } from '@/lib/admin/pricing-video-token-expression';
import { pricingCostConfigSchema } from '@/lib/admin/pricing-cost';

/** doubao-seedance-2-0-mini official prices, in canonical cell order. */
const MINI = [23, 14, 23, 14, 25.5, 15.5, 25.5, 15.5];

const quote = (prices: number[], buy: number, sell: number): VideoQuoteInput => ({
    official: VIDEO_TOKEN_COMBOS.map((combo, index) => ({ ...combo, price: prices[index] })),
    buy_discount: buy,
    sell_discount: sell,
});

const byKey = (input: VideoQuoteInput, fx: number, ratio: number) =>
    new Map(computeVideoQuote(input, fx, ratio).map((cell) => [videoTokenKey(cell), cell]));

describe('computeVideoQuote', () => {
    it('prices every cell at the group ratio of 1 (production fx)', () => {
        const cells = byKey(quote(MINI, 0.36, 0.7), 1, 1);
        const cell = cells.get('480p·none')!;
        expect(cell.official).toBe(23);
        expect(cell.cost).toBe(8.28); // 23 × 0.36
        expect(cell.target).toBe(16.1); // 23 × 0.7
        expect(cell.coefficient).toBe(16.1);
        expect(cell.actual).toBe(16.1);
        expect(cell.margin).toBeCloseTo((16.1 - 8.28) / 16.1, 6);
    });

    it('divides by the group ratio so the customer still pays the target', () => {
        // SD官转 today: GroupRatio 7.5, so the coefficient is the target ÷ 7.5.
        const cell = byKey(quote(MINI, 0.36, 0.7), 1, 7.5).get('480p·none')!;
        expect(cell.target).toBe(16.1);
        expect(cell.coefficient).toBe(2.15); // 16.1 / 7.5 = 2.1466… → up to 2.15
        expect(cell.actual).toBe(16.125); // 2.15 × 7.5, at or above target
        expect(cell.actual).toBeGreaterThanOrEqual(cell.target);
    });

    it('always rounds the coefficient up, never below target', () => {
        for (const ratio of [1, 1.2, 7.5]) {
            for (const cell of computeVideoQuote(quote(MINI, 0.36, 0.7), 1, ratio)) {
                expect(cell.actual).toBeGreaterThanOrEqual(cell.target);
                expect(Number(cell.coefficient.toFixed(2))).toBe(cell.coefficient);
            }
        }
    });

    it('keeps two-decimal coefficients exact (no float drift)', () => {
        const cell = byKey(quote([10.27, 6.14, 10.27, 6.14, 10.27, 6.14, 10.27, 6.14], 0.7, 1), 1, 1).get('480p·none')!;
        expect(cell.coefficient).toBe(10.27);
        expect(cell.actual).toBe(10.27);
    });

    it('reports the margin against our cost', () => {
        const cell = byKey(quote(MINI, 0.5, 1), 1, 1).get('480p·none')!;
        expect(cell.cost).toBe(11.5);
        expect(cell.actual).toBe(23);
        expect(cell.margin).toBe(0.5);
    });

    it('refuses a sell discount below the buy discount', () => {
        expect(() => computeVideoQuote(quote(MINI, 0.7, 0.5), 1, 1)).toThrow(/亏损/);
    });

    it('refuses discounts outside (0, 2]', () => {
        for (const [buy, sell] of [
            [0, 0.7],
            [0.36, 0],
            [0.36, 2.5],
            [-1, 0.7],
        ])
            expect(() => computeVideoQuote(quote(MINI, buy, sell), 1, 1)).toThrow();
    });

    it('refuses an invalid fx or group ratio', () => {
        expect(() => computeVideoQuote(quote(MINI, 0.36, 0.7), 0, 1)).toThrow(/倍率或换算比例/);
        expect(() => computeVideoQuote(quote(MINI, 0.36, 0.7), 1, 0)).toThrow(/倍率或换算比例/);
    });

    it('requires a positive official price in all eight cells', () => {
        const missing = quote(MINI, 0.36, 0.7);
        missing.official = missing.official.slice(0, 7);
        expect(() => computeVideoQuote(missing, 1, 1)).toThrow(/全部 8 档/);

        const zero = quote([23, 0, 23, 14, 25.5, 15.5, 25.5, 15.5], 0.36, 0.7);
        expect(() => computeVideoQuote(zero, 1, 1)).toThrow(/官方价/);
    });
});

describe('videoQuoteCostConfig / videoQuoteFromCostConfig', () => {
    it('stores a quote the cost schema accepts and reads it back unchanged', () => {
        const input = quote(MINI, 0.36, 0.7);
        const config = videoQuoteCostConfig(input);
        expect(pricingCostConfigSchema.safeParse(config).success).toBe(true);
        const restored = videoQuoteFromCostConfig(pricingCostConfigSchema.parse(config));
        expect(restored).toEqual(input);
    });

    it('returns null for cost data that is not a video-token quote', () => {
        const config = pricingCostConfigSchema.parse(videoQuoteCostConfig(quote(MINI, 0.36, 0.7)));
        expect(videoQuoteFromCostConfig({ ...config, basis: 'token' })).toBeNull();
        expect(videoQuoteFromCostConfig({ ...config, video_unit: 'second' })).toBeNull();
        expect(videoQuoteFromCostConfig({ ...config, retail_multiplier: undefined })).toBeNull();
        expect(videoQuoteFromCostConfig({ ...config, variants: config.variants.slice(0, 7) })).toBeNull();
    });
});

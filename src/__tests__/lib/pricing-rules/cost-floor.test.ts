import { describe, expect, it } from 'vitest';
import type { PricingCostConfig } from '@/lib/admin/pricing-cost-types';
import { costFloor } from '@/lib/pricing-rules/cost-floor';
import { USD_TO_CNY_RATE, quotaToCny } from '@/lib/newapi/quota-units';

const CHAT_FX = quotaToCny(1_000_000);

const tokens = (input: number, output: number): PricingCostConfig => ({
    version: 1,
    basis: 'token',
    currency: 'cny',
    credits_per_cny: 1,
    upstream_multiplier: 1,
    markup_percent: 0,
    source_note: '',
    token_rates: { input, output, cache_read: null, cache_write: null },
    variants: [],
});

const image = (price: number): PricingCostConfig => ({
    version: 1,
    basis: 'image',
    currency: 'cny',
    credits_per_cny: 1,
    upstream_multiplier: 1,
    markup_percent: 0,
    source_note: '',
    token_rates: { input: null, output: null, cache_read: null, cache_write: null },
    variants: [
        {
            key: 'std',
            label: '标准',
            resolution: '1024x1024',
            audio: 'any',
            reference_video: 'any',
            price,
            minimum_units: 1,
            step_units: 1,
        },
    ],
});

describe('costFloor', () => {
    it('takes the strictest token line', () => {
        const options = { ModelRatio: '{"m":0.5}', CompletionRatio: '{"m":2}' };
        const result = costFloor(tokens(2, 8), 'm', options);
        expect(result.checked).toBe(true);
        // input: 2 / (FX*0.5); output: 8 / (FX*0.5*2). Output is stricter.
        expect(result.floor).toBeCloseTo(Math.max(2 / (CHAT_FX * 0.5), 8 / (CHAT_FX * 0.5 * 2)), 12);
    });

    it('checks single-variant per-image prices against ModelPrice', () => {
        const result = costFloor(image(0.3), 'img', { ModelPrice: '{"img":0.25}' });
        expect(result.floor).toBeCloseTo(0.3 / (0.25 * USD_TO_CNY_RATE), 12);
    });

    it('reports what it cannot check instead of guessing', () => {
        expect(costFloor(tokens(2, 8), 'm', {}).reason).toBe('缺少模型倍率');
        expect(costFloor(tokens(2, 8), 'm', { 'billing_setting.billing_mode': '{"m":"tiered_expr"}' }).checked).toBe(
            false,
        );
        expect(costFloor({ basis: 'token' }, 'm', { ModelRatio: '{"m":1}' }).reason).toBe('成本配置无效');
        expect(costFloor(image(0.3), 'img', {}).floor).toBeNull();
    });
});

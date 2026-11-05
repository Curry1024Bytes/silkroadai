/**
 * Lowest group factor at which a model still sells at or above its recorded
 * purchasing cost (spec §11.8). Pure: callers pass the cost-rule configs and the
 * live new-api price options.
 *
 * Token prices per 1M = CHAT_FX × ModelRatio × factor (× CompletionRatio for
 * output, × CacheRatio for cache reads). Per-image prices = ModelPrice ×
 * IMAGE_FX × factor. Tiered expressions, video and multi-variant images are not
 * checked; they are reported as unchecked instead of being guessed.
 */
import { calculateCostPricing } from '@/lib/admin/pricing-cost';
import type { PricingCostConfig } from '@/lib/admin/pricing-cost-types';
import { USD_TO_CNY_RATE, quotaToCny } from '@/lib/newapi/quota-units';

const CHAT_FX = quotaToCny(1_000_000);
const IMAGE_FX = USD_TO_CNY_RATE;

export interface CostFloor {
    /** Lowest factor that keeps every checked price line at or above cost. */
    floor: number | null;
    checked: boolean;
    reason: string | null;
}

function dict(options: Record<string, unknown>, key: string): Record<string, unknown> {
    const raw = options[key];
    if (raw === undefined || raw === null || raw === '') return {};
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function positive(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function costFloor(config: unknown, modelName: string, options: Record<string, unknown>): CostFloor {
    const modes = dict(options, 'billing_setting.billing_mode');
    if (modes[modelName] === 'tiered_expr') return { floor: null, checked: false, reason: '阶梯计费未核对成本' };
    let lines;
    try {
        lines = calculateCostPricing(config as PricingCostConfig).lines;
    } catch {
        return { floor: null, checked: false, reason: '成本配置无效' };
    }
    const basis = (config as PricingCostConfig).basis;
    const floors: number[] = [];
    if (basis === 'token') {
        const ratio = positive(dict(options, 'ModelRatio')[modelName]);
        if (ratio === null) return { floor: null, checked: false, reason: '缺少模型倍率' };
        const completion = positive(dict(options, 'CompletionRatio')[modelName]) ?? 1;
        const cache = positive(dict(options, 'CacheRatio')[modelName]);
        for (const line of lines) {
            const unit =
                line.key === 'input'
                    ? CHAT_FX * ratio
                    : line.key === 'output'
                      ? CHAT_FX * ratio * completion
                      : line.key === 'cache_read' && cache !== null
                        ? CHAT_FX * ratio * cache
                        : null;
            if (unit !== null && line.cost > 0) floors.push(line.cost / unit);
        }
    } else if (basis === 'image') {
        const price = positive(dict(options, 'ModelPrice')[modelName]);
        if (price === null || lines.length !== 1) return { floor: null, checked: false, reason: '图片规格未核对成本' };
        if (lines[0].cost > 0) floors.push(lines[0].cost / (price * IMAGE_FX));
    } else return { floor: null, checked: false, reason: '视频成本尚不能核对' };
    return floors.length
        ? { floor: Math.max(...floors), checked: true, reason: null }
        : { floor: null, checked: false, reason: '没有可核对的成本项' };
}

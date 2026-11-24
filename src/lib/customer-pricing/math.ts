import { createHash } from 'node:crypto';
import type { BasePrice } from '@/lib/admin/pricing-simple-core';
import { ceilToScale, compare, divide, multiply, parseDecimal, toNumber } from '@/lib/pricing-rules/decimal';
import type { OfficialCustomerRule, OfficialModelContext, OfficialPriceCell } from './types';

export class CustomerPricingError extends Error {
    constructor(
        public code: string,
        message: string,
        public status = 409,
    ) {
        super(message);
        this.name = 'CustomerPricingError';
    }
}

export function fingerprint(value: unknown): string {
    const normalize = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(normalize);
        if (v && typeof v === 'object')
            return Object.fromEntries(
                Object.entries(v)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([k, x]) => [k, normalize(x)]),
            );
        return v;
    };
    return createHash('sha256')
        .update(JSON.stringify(normalize(value)))
        .digest('hex');
}

export function internalModelGroup(tier: string, modelId: string): string {
    return `portal-price-${fingerprint([tier, modelId]).slice(0, 32)}`;
}

export function roundPrice(value: number): number {
    return Number(value.toFixed(12));
}

const RATE_LABELS: Record<string, string> = {
    input: '输入',
    output: '输出',
    cache_read: '缓存读取',
    cache_write: '缓存写入',
    cache_write_1h: '缓存写入 1 小时',
    cache_write_12h: '缓存写入 12 小时',
};

export interface BaseCell {
    key: string;
    label: string;
    unit: 'million_tokens' | 'call';
    amount: number;
}

/** Include every billed component, not only a card's representative input/output rate. */
export function flattenBase(base: BasePrice, fx: number): { shape: string; cells: BaseCell[] } {
    if (!(fx > 0) || !Number.isFinite(fx)) throw new CustomerPricingError('invalid_fx', '计价单位换算无效。');
    const cells: BaseCell[] = [];
    if (base.mode === 'video_token') {
        for (const c of base.cells)
            cells.push({
                key: `${c.resolution}·${c.video_input}`,
                label: `${c.resolution} · ${c.video_input === 'video' ? '有参考视频' : '无参考视频'}`,
                unit: 'million_tokens',
                amount: roundPrice(c.price * fx),
            });
        return {
            shape: fingerprint({ mode: base.mode, keys: cells.map((c) => c.key), fallback: base.fallback }),
            cells,
        };
    }
    if (base.mode === 'per_call')
        return {
            shape: 'per_call',
            cells: [{ key: 'call', label: '每次', unit: 'call', amount: roundPrice(base.price * fx) }],
        };
    const tiers =
        base.mode === 'tiered'
            ? base.tiers
            : [
                  {
                      max_input_tokens: null,
                      max_inclusive: false,
                      rates: {
                          input: base.input,
                          output: base.output,
                          cache_read: base.cache_read ?? base.input,
                          cache_write: base.cache_write ?? base.input * 1.25,
                          cache_write_1h: (base.cache_write ?? base.input * 1.25) * 1.6,
                          cache_write_12h: (base.cache_write ?? base.input * 1.25) * 2,
                      },
                  },
              ];
    for (const [index, tier] of tiers.entries()) {
        for (const [key, value] of Object.entries(tier.rates)) {
            if (value === null || value === undefined) continue;
            cells.push({
                key: `${index}:${key}`,
                label: `${tiers.length > 1 ? `第 ${index + 1} 档 · ` : ''}${RATE_LABELS[key] ?? key}`,
                unit: 'million_tokens',
                amount: roundPrice(value * fx),
            });
        }
    }
    return {
        shape: fingerprint({
            mode: base.mode,
            tiers: tiers.map((t) => [t.max_input_tokens, t.max_inclusive]),
            keys: cells.map((c) => c.key),
        }),
        cells,
    };
}

/** One winning rule. A customer's explicit model price always wins over their tier default. */
export function selectOfficialRule(
    rules: OfficialCustomerRule[],
    tier: string,
    modelId: string,
): OfficialCustomerRule | null {
    const applicable = rules.filter((r) => r.tier_key === tier && (r.model_id === modelId || r.model_id === null));
    if (
        applicable.filter((r) => r.model_id === modelId).length > 1 ||
        applicable.filter((r) => r.model_id === null).length > 1
    )
        throw new CustomerPricingError('ambiguous_rule', '客户定价规则重复，拒绝猜测生效价格。');
    return applicable.find((r) => r.model_id === modelId) ?? applicable.find((r) => r.model_id === null) ?? null;
}

/** A native model group has one factor. All rates must be proportional to the official reference. */
export function officialBaseScale(cells: OfficialPriceCell[]): number {
    let scale: ReturnType<typeof parseDecimal> | null = null;
    for (const cell of cells) {
        if (
            !Number.isFinite(cell.official_cny) ||
            cell.official_cny < 0 ||
            !Number.isFinite(cell.base_cny) ||
            cell.base_cny < 0
        )
            throw new CustomerPricingError('invalid_reference', '官方基准或实际计费系数无效。');
        if (cell.official_cny === 0 && cell.base_cny === 0) continue;
        if (cell.official_cny <= 0 || cell.base_cny <= 0)
            throw new CustomerPricingError('nonproportional_reference', '官方基准与实际计费规则存在零价格差异。');
        const next = divide(parseDecimal(String(cell.official_cny)), parseDecimal(String(cell.base_cny)));
        if (scale && compare(scale, next) !== 0)
            throw new CustomerPricingError(
                'nonproportional_reference',
                '该模型不同计费档位与官方价的比例不一致，无法用一个模型倍率准确表达。请先核对模型基础价。',
            );
        scale = next;
    }
    if (!scale) throw new CustomerPricingError('empty_reference', '没有可定价的官方基准。');
    return toNumber(scale);
}

export function compileOfficialRatio(model: OfficialModelContext, multiplier: number): number {
    if (!(multiplier > 0 && multiplier <= 100) || !Number.isFinite(multiplier))
        throw new CustomerPricingError('invalid_multiplier', '官方价倍率须大于 0 且不超过 100。', 400);
    if (!model.reference_available)
        throw new CustomerPricingError(
            'missing_reference',
            model.unavailable_reason ?? '请先确认该模型的官方基准价格。',
        );
    officialBaseScale(model.cells);
    const first = model.cells.find((c) => c.base_cny > 0)!;
    const target = multiply(parseDecimal(String(first.official_cny)), parseDecimal(String(multiplier)));
    const ratio = toNumber(ceilToScale(divide(target, parseDecimal(String(first.base_cny))), 12));
    if (!(ratio > 0 && Number.isFinite(ratio)))
        throw new CustomerPricingError('invalid_native_ratio', '计算后的计费倍率无效。');
    for (const cell of model.cells) {
        const expected = cell.official_cny * multiplier;
        const actual = cell.base_cny * ratio;
        if (Math.abs(actual - expected) > 0.000001 + Math.abs(expected) * 1e-11)
            throw new CustomerPricingError('ratio_precision', '计费倍率的精度不足以表达目标价格。');
    }
    return ratio;
}

/**
 * The customer's contracted price per cell: official × multiplier, computed exactly.
 * The native ratio can only approximate official/base (e.g. 0.7 / 0.72 = 35/36), so a
 * price derived from it carries a 1e-11 tail that integer quota settlement drops.
 * Customers must see the contracted amount, so every cell is checked against the
 * actually billed rate before the exact amount replaces it.
 */
export function exactOfficialAmounts(
    model: OfficialModelContext,
    multiplier: number,
    nativeRatio: number,
): Map<string, number> {
    const result = new Map<string, number>();
    for (const cell of model.cells) {
        const exact = toNumber(multiply(parseDecimal(String(cell.official_cny)), parseDecimal(String(multiplier))));
        const billed = cell.base_cny * nativeRatio;
        if (Math.abs(billed - exact) > 0.000001 + Math.abs(exact) * 1e-11)
            throw new CustomerPricingError('customer_price_drift', '实际扣费倍率与客户专属价格不一致。');
        result.set(cell.key, exact);
    }
    return result;
}

export function officialMultiplierOf(cells: OfficialPriceCell[], nativeRatio: number): number | null {
    try {
        const first = cells.find((c) => c.official_cny > 0);
        if (!first) return null;
        officialBaseScale(cells);
        return roundPrice((first.base_cny * nativeRatio) / first.official_cny);
    } catch {
        return null;
    }
}
